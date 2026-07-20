'use strict';

/*
 * Ctrl+Scroll Zoom — Obsidian plugin
 * Ctrl + wheel up   -> zoom in
 * Ctrl + wheel down -> zoom out
 * Zooms the whole app via Electron's webFrame zoom factor (UI + note text),
 * like Ctrl+wheel in a browser. Trackpad pinch also triggers it because the
 * browser reports pinch as a Ctrl+wheel event.
 */

const { Plugin, PluginSettingTab, Setting } = require('obsidian');

const DEFAULT_SETTINGS = {
  zoomTarget: 'app', // 'app' (webFrame, zooms all UI) | 'content' (CSS zoom, note only)
  step: 0.1, // zoom change per wheel notch, applied multiplicatively (0.1 = ×1.1)
  minZoom: 0.3, // lower clamp for the zoom factor
  maxZoom: 5.0, // upper clamp for the zoom factor
  modifier: 'ctrl', // 'ctrl' | 'meta' | 'alt'
  passThroughViews: true, // let Canvas/Excalidraw/PDF keep their own Ctrl+wheel zoom
  showStatusBar: true,
  zoomFactor: 1.0, // last applied zoom, restored on load
};

// Views with their own spatial Ctrl+wheel zoom; when passThroughViews is on,
// wheel events originating inside these are always left alone.
const PASS_THROUGH_CANVAS = [
  '.canvas-wrapper', // core Canvas
  '.excalidraw-wrapper', // Excalidraw plugin
  '.excalidraw',
].join(', ');

// The built-in PDF viewer zooms itself with Ctrl+wheel. In content mode the
// PDF *is* the open content, so its own zoom is the right one; in whole-app
// mode the app zoom takes over even above PDFs.
const PASS_THROUGH_PDF = [
  '.pdf-container',
  '.pdf-viewer-container',
  '.pdf-embed',
].join(', ');

// Consecutive wheel events closer together than this are treated as one
// gesture (pinch or fast scroll) and accumulate on an unrounded zoom value,
// so sub-percent pinch deltas don't get swallowed by rounding.
const GESTURE_TIMEOUT_MS = 250;

// A conventional mouse-wheel notch in Chromium's pixel delta units.
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const MAX_STEPS_PER_EVENT = 3; // cap huge synthetic deltas (fast trackpad flicks)

// Obsidian desktop runs in an Electron renderer; webFrame controls page zoom.
function getWebFrame() {
  try {
    return require('electron').webFrame;
  } catch (e) {
    try {
      return window.require('electron').webFrame;
    } catch (e2) {
      return null;
    }
  }
}

module.exports = class CtrlScrollZoomPlugin extends Plugin {
  async onload() {
    this.webFrame = getWebFrame();
    this._attachedWindows = new WeakSet();
    this._windows = new Set(); // iterable window list for content-mode rendering
    this._gestureZoom = null;
    this._gestureTime = 0;
    this._alive = true;
    this._hookedPdfBuses = new WeakSet();
    this._pdfBusListeners = [];
    this._anchor = null;
    this._anchorTime = 0;
    this._anchorTimer = null;
    this._contentRaf = null;
    this._pendingContent = null;
    await this.loadSettings();

    // Restore the zoom from the previous session onto the chosen target.
    this._windows.add(window);
    this.restoreZoom();

    // Status bar indicator (click to reset to 100%).
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('ctrl-scroll-zoom-status');
    this.statusEl.setAttribute('aria-label', 'Click to reset zoom to 100%');
    this.registerDomEvent(this.statusEl, 'click', () => this.resetAllZoom());
    this.updateStatusBar();

    // Wheel handler on the main window, every existing pop-out window, and
    // any pop-out opened later.
    this.attachToWindow(window);
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const win = leaf.view?.containerEl?.ownerDocument?.defaultView;
        if (win) this.attachToWindow(win);
      });
      this.hookActivePdf();
      this.updateStatusBar();
    });
    this.registerEvent(
      this.app.workspace.on('window-open', (workspaceWindow) => {
        if (workspaceWindow?.win) this.attachToWindow(workspaceWindow.win);
      })
    );

    // Obsidian's built-in Ctrl+= / Ctrl+- also change the zoom factor; a zoom
    // change always fires a resize, so re-sync the indicator (and persist the
    // new factor) whenever that happens.
    this.registerDomEvent(window, 'resize', () => this.syncFromWebFrame());

    // When a PDF becomes active, watch its own zoom so the status bar can
    // show it (PDFs zoom themselves when passThroughViews is on).
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        this.hookActivePdf();
        this.updateStatusBar();
      })
    );

    // Command palette entries (also assignable to hotkeys).
    this.addCommand({
      id: 'zoom-in',
      name: 'Zoom in',
      callback: () => this.changeZoomSteps(1),
    });
    this.addCommand({
      id: 'zoom-out',
      name: 'Zoom out',
      callback: () => this.changeZoomSteps(-1),
    });
    this.addCommand({
      id: 'reset-zoom',
      name: 'Reset zoom to 100%',
      callback: () => this.setZoom(1.0),
    });

    this.addSettingTab(new CtrlScrollZoomSettingTab(this.app, this));
  }

  onunload() {
    this._alive = false;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._contentRaf != null) {
      cancelAnimationFrame(this._contentRaf);
      this._contentRaf = null;
    }
    clearTimeout(this._anchorTimer);
    // Remove the content-zoom class/variable; the styles.css rule disappears
    // with the plugin anyway, this just keeps the DOM clean.
    for (const win of this._windows) {
      if (win.closed) continue;
      const body = win.document && win.document.body;
      if (body) {
        body.classList.remove('csz-content-zoom');
        body.style.removeProperty('--csz-zoom');
      }
    }
    this._windows.clear();
    for (const { bus, handler } of this._pdfBusListeners) {
      try {
        bus.off('scalechanging', handler);
      } catch (e) {
        /* viewer already torn down */
      }
    }
    this._pdfBusListeners = [];
    // The wheel/click listeners are removed automatically (registerDomEvent).
    // Leave the current zoom as-is so the user's choice persists.
  }

  // ---- PDF viewer integration -------------------------------------------
  // The built-in PDF viewer (pdf.js) zooms itself when passThroughViews is
  // on, so the status bar mirrors its zoom while a PDF is the active view.
  // These touch undocumented Obsidian internals, so every access is optional
  // and failure just falls back to showing the app zoom only.

  // Returns Obsidian's wrapper around the pdf.js viewer for the active PDF
  // view, or null.
  getActivePdfViewer() {
    const view = this.app.workspace.activeLeaf?.view;
    if (!view || typeof view.getViewType !== 'function' || view.getViewType() !== 'pdf') {
      return null;
    }
    return view.viewer?.child?.pdfViewer ?? null;
  }

  getActivePdfScale() {
    const scale = this.getActivePdfViewer()?.pdfViewer?.currentScale;
    return typeof scale === 'number' && isFinite(scale) ? scale : null;
  }

  // Subscribe to the active PDF's scale changes so the indicator updates
  // live. The pdf.js viewer loads asynchronously, so retry briefly when the
  // event bus isn't there yet.
  hookActivePdf(attempt = 0) {
    if (!this._alive) return;
    const obsViewer = this.getActivePdfViewer();
    if (!obsViewer) return;
    const bus = obsViewer.eventBus;
    if (!bus || typeof bus.on !== 'function') {
      if (attempt < 8) setTimeout(() => this.hookActivePdf(attempt + 1), 400);
      return;
    }
    if (this._hookedPdfBuses.has(bus)) return;
    this._hookedPdfBuses.add(bus);
    const handler = () => this.updateStatusBar();
    bus.on('scalechanging', handler);
    this._pdfBusListeners.push({ bus, handler });
  }

  // Status-bar click: reset the app zoom and, if a PDF is active, its own
  // zoom as well.
  resetAllZoom() {
    const raw = this.getActivePdfViewer()?.pdfViewer;
    if (raw && typeof raw.currentScale === 'number') {
      try {
        raw.currentScaleValue = '1';
      } catch (e) {
        /* leave the PDF zoom alone if internals changed */
      }
    }
    this.setZoom(1.0);
  }

  // Global Ctrl+wheel handler. Capture phase + non-passive so we can stop
  // the default scroll and beat any pane-local wheel handlers.
  attachToWindow(win) {
    if (!win || this._attachedWindows.has(win)) return;
    this._attachedWindows.add(win);
    this._windows.add(win);
    // A pop-out opened while zoomed in content mode starts at the saved zoom.
    if (this.settings.zoomTarget === 'content') this.applyContentToWindow(win);
    this.registerDomEvent(
      win,
      'wheel',
      (evt) => this.onWheel(evt),
      { passive: false, capture: true }
    );
  }

  onWheel(evt) {
    if (!this.modifierHeld(evt)) return;
    const content = this.settings.zoomTarget === 'content';
    if (!content && !this.webFrame) return;
    if (evt.deltaY === 0) return;
    if (this.settings.passThroughViews && evt.target instanceof Element) {
      if (evt.target.closest(PASS_THROUGH_CANVAS)) {
        return; // Canvas/Excalidraw zoom themselves in both modes
      }
      if (content && evt.target.closest(PASS_THROUGH_PDF)) {
        return; // content mode: the PDF is the content, let it zoom itself
      }
    }
    evt.preventDefault();
    evt.stopPropagation();
    if (content) this.trackWheelAnchor(evt);
    this.changeZoomSteps(-this.wheelSteps(evt), true);
  }

  // Content mode: keep the point under the cursor stationary for the duration
  // of one wheel session (consecutive events; a pause starts a new session).
  trackWheelAnchor(evt) {
    const now = Date.now();
    if (!this._anchor || now - this._anchorTime > GESTURE_TIMEOUT_MS) {
      this._anchor = this.beginAnchor(evt.target, evt.clientY);
    }
    this._anchorTime = now;
    clearTimeout(this._anchorTimer);
    this._anchorTimer = setTimeout(() => {
      this._anchor = null;
    }, GESTURE_TIMEOUT_MS + 50);
  }

  modifierHeld(evt) {
    switch (this.settings.modifier) {
      case 'meta':
        return evt.metaKey;
      case 'alt':
        return evt.altKey;
      default:
        // Trackpad pinch is reported as a Ctrl+wheel event, so this also
        // covers pinch-to-zoom.
        return evt.ctrlKey;
    }
  }

  // Convert a wheel event into (possibly fractional) zoom steps, so a mouse
  // notch is exactly one step while a trackpad pinch — a stream of small
  // pixel deltas — zooms proportionally instead of jumping a full step per
  // event.
  wheelSteps(evt) {
    let steps;
    if (evt.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      steps = evt.deltaY / LINES_PER_NOTCH;
    } else if (evt.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      steps = Math.sign(evt.deltaY);
    } else {
      steps = evt.deltaY / PIXELS_PER_NOTCH;
    }
    return Math.max(-MAX_STEPS_PER_EVENT, Math.min(MAX_STEPS_PER_EVENT, steps));
  }

  clamp(z) {
    if (isNaN(z)) return 1.0;
    const lo = Math.min(this.settings.minZoom, this.settings.maxZoom);
    const hi = Math.max(this.settings.minZoom, this.settings.maxZoom);
    return Math.min(hi, Math.max(lo, z));
  }

  applyZoom(z) {
    if (this.webFrame) this.webFrame.setZoomFactor(z);
  }

  getZoom() {
    if (this.settings.zoomTarget === 'content') return this.settings.zoomFactor;
    return this.webFrame ? this.webFrame.getZoomFactor() : this.settings.zoomFactor;
  }

  restoreZoom() {
    const z = this.clamp(this.settings.zoomFactor);
    if (this.settings.zoomTarget === 'content') {
      this.renderContentZoom(z);
    } else if (this.webFrame) {
      this.applyZoom(z);
    }
  }

  // ---- content-mode rendering --------------------------------------------
  // Content mode zooms only the open note (editor .cm-sizer / reading view)
  // via a CSS variable; the ribbon, sidebars and tab bar stay at 100%. The
  // rule lives in styles.css so Obsidian mirrors it into pop-out windows.

  applyContentToWindow(win, z = this.settings.zoomFactor) {
    const body = win.document && win.document.body;
    if (!body) return;
    body.classList.add('csz-content-zoom');
    body.style.setProperty('--csz-zoom', String(z));
  }

  renderContentZoom(z) {
    for (const win of this._windows) {
      if (win.closed) {
        this._windows.delete(win);
        continue;
      }
      this.applyContentToWindow(win, z);
    }
    if (this._anchor) this.applyAnchor(this._anchor, z);
  }

  // CSS zoom re-lays the note out, so coalesce rapid wheel events into one
  // application per animation frame to keep the gesture smooth.
  requestContentApply(z) {
    this._pendingContent = z;
    if (this._contentRaf != null) return;
    this._contentRaf = requestAnimationFrame(() => {
      this._contentRaf = null;
      if (this._pendingContent != null) {
        this.renderContentZoom(this._pendingContent);
        this._pendingContent = null;
      }
    });
  }

  // ---- scroll anchoring (content mode) -------------------------------------

  // The scrollable note container at/under the gesture, or in the active view.
  // Only the zoomed pane's own scroller qualifies — embeds and hover popovers
  // contain nested .markdown-preview-view elements that are not scrollable
  // (or not zoomed at all), so anchoring to them would drift or scroll the
  // wrong element.
  findScroller(target) {
    let el = target instanceof Element ? target : null;
    while (el) {
      const hit = el.closest('.cm-scroller, .markdown-preview-view');
      if (!hit) break;
      if (hit.closest('.view-content') && !hit.closest('.markdown-embed')) return hit;
      el = hit.parentElement;
    }
    const leaf = this.app.workspace.getMostRecentLeaf();
    const contentEl = leaf && leaf.view && leaf.view.contentEl;
    return contentEl ? contentEl.querySelector('.cm-scroller, .markdown-preview-view') : null;
  }

  beginAnchor(target, clientY) {
    const scroller = this.findScroller(target);
    if (!scroller) return null;
    return {
      scroller,
      offsetY: clientY - scroller.getBoundingClientRect().top,
      startZoom: this.settings.zoomFactor,
      startScroll: scroller.scrollTop,
      // The reading view zooms the scroller itself, so its scroll coordinates
      // live in the zoomed space; the editor zooms a child (.cm-sizer).
      zoomedScroller: scroller.classList.contains('markdown-preview-view'),
    };
  }

  applyAnchor(anchor, z) {
    const { scroller, offsetY, startZoom, startScroll, zoomedScroller } = anchor;
    scroller.scrollTop = zoomedScroller
      ? startScroll + offsetY / startZoom - offsetY / z
      : (startScroll + offsetY) * (z / startZoom) - offsetY;
  }

  // Commands/reset in content mode: keep the middle of the note stationary.
  anchorViewportCenter() {
    const scroller = this.findScroller(null);
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    this._anchor = this.beginAnchor(scroller, rect.top + rect.height / 2);
    clearTimeout(this._anchorTimer);
    this._anchorTimer = setTimeout(() => {
      this._anchor = null;
    }, GESTURE_TIMEOUT_MS + 50);
  }

  // Change the zoom by n steps (fractional during a pinch). Multiplicative:
  // each step scales by (1 + step), so the perceived change is the same at
  // 50% and at 300%, and repeated steps can't accumulate float drift the way
  // additive steps did.
  changeZoomSteps(n, gesture) {
    const now = Date.now();
    let base;
    if (gesture && this._gestureZoom !== null && now - this._gestureTime < GESTURE_TIMEOUT_MS) {
      base = this._gestureZoom;
    } else {
      base = this.getZoom();
    }
    const target = this.clamp(base * Math.pow(1 + this.settings.step, n));
    if (gesture) {
      this._gestureZoom = target;
      this._gestureTime = now;
    }
    this.setZoom(target);
  }

  setZoom(z) {
    // Round what we apply/persist to 1/10000 so saved values stay clean.
    const clamped = Math.round(this.clamp(z) * 10000) / 10000;
    // Content mode: without an anchor, changing the zoom leaves scrollTop
    // pointing at a different part of the note (it is measured in zoomed
    // pixels), so commands/reset anchor the viewport center. Must run before
    // zoomFactor changes — the anchor captures the current zoom and scroll.
    if (this.settings.zoomTarget === 'content' && this._anchor == null) {
      this.anchorViewportCenter();
    }
    this.settings.zoomFactor = clamped;
    if (this.settings.zoomTarget === 'content') {
      this.requestContentApply(clamped);
    } else {
      this.applyZoom(clamped);
    }
    this.updateStatusBar();
    this.debouncedSave();
  }

  // Pick up zoom changes made outside this plugin (built-in Ctrl+= / Ctrl+-).
  // Only meaningful for the app target — in content mode the webFrame factor
  // is not ours to track and must not overwrite the saved content zoom.
  syncFromWebFrame() {
    if (!this.webFrame || this.settings.zoomTarget !== 'app') return;
    const cur = Math.round(this.webFrame.getZoomFactor() * 10000) / 10000;
    if (cur !== this.settings.zoomFactor) {
      this.settings.zoomFactor = cur;
      this.debouncedSave();
    }
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    const visible =
      this.settings.showStatusBar &&
      (!!this.webFrame || this.settings.zoomTarget === 'content');
    this.statusEl.toggleClass('ctrl-scroll-zoom-hidden', !visible);
    if (!visible) {
      this.statusEl.setText('');
      return;
    }
    const appPct = Math.round(this.getZoom() * 100);
    const pdfScale = this.getActivePdfScale();
    if (pdfScale !== null) {
      const pdfPct = Math.round(pdfScale * 100);
      this.statusEl.setText(
        appPct === 100
          ? '🔍 PDF ' + pdfPct + '%'
          : '🔍 ' + appPct + '% | PDF ' + pdfPct + '%'
      );
      this.statusEl.setAttribute('aria-label', 'Click to reset zoom (app and PDF) to 100%');
    } else {
      this.statusEl.setText('🔍 ' + appPct + '%');
      this.statusEl.setAttribute('aria-label', 'Click to reset zoom to 100%');
    }
  }

  debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSettings();
    }, 400);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class CtrlScrollZoomSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Zoom target')
      .setDesc(
        'Whole app zooms everything (UI included), like a browser. Note content only keeps the ribbon, sidebars and tab bar at 100% and zooms just the open note; PDFs keep their own built-in Ctrl+scroll zoom there. Switching resets the zoom to 100%.'
      )
      .addDropdown((d) =>
        d
          .addOption('app', 'Whole app')
          .addOption('content', 'Note content only')
          .setValue(this.plugin.settings.zoomTarget)
          .onChange(async (v) => {
            if (v === this.plugin.settings.zoomTarget) return;
            this.plugin.setZoom(1.0); // reset the old target before switching
            this.plugin.settings.zoomTarget = v;
            this.plugin.setZoom(1.0); // render the new target at 100%
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Zoom step')
      .setDesc('How much one wheel notch changes the zoom (10% = ×1.1 per notch).')
      .addSlider((s) =>
        s
          .setLimits(1, 50, 1)
          .setValue(Math.round(this.plugin.settings.step * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.step = v / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Minimum zoom')
      .setDesc('Lower bound, in percent (cannot exceed the maximum).')
      .addSlider((s) =>
        s
          .setLimits(10, 100, 5)
          .setValue(Math.round(this.plugin.settings.minZoom * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            const capped = Math.min(v, Math.round(this.plugin.settings.maxZoom * 100));
            this.plugin.settings.minZoom = capped / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Maximum zoom')
      .setDesc(
        'Upper bound, in percent (cannot go below the minimum). Note: in Whole app mode the runtime caps the effective zoom around 500%; Note content mode can use the full range.'
      )
      .addSlider((s) =>
        s
          .setLimits(100, 1000, 10)
          .setValue(Math.round(this.plugin.settings.maxZoom * 100))
          .setDynamicTooltip()
          .onChange(async (v) => {
            const capped = Math.max(v, Math.round(this.plugin.settings.minZoom * 100));
            this.plugin.settings.maxZoom = capped / 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Modifier key')
      .setDesc(
        'Key to hold while scrolling. Trackpad pinch always registers as Ctrl, so pinch-to-zoom only works with Ctrl.'
      )
      .addDropdown((d) =>
        d
          .addOption('ctrl', 'Ctrl')
          .addOption('meta', 'Cmd / Win')
          .addOption('alt', 'Alt / Option')
          .setValue(this.plugin.settings.modifier)
          .onChange(async (v) => {
            this.plugin.settings.modifier = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Let Canvas and Excalidraw zoom themselves')
      .setDesc(
        'These views have their own spatial Ctrl+scroll zoom and are left alone when enabled. PDFs use their own zoom only in Note content mode; in Whole app mode the app zoom applies above PDFs too.'
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.passThroughViews).onChange(async (v) => {
          this.plugin.settings.passThroughViews = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Show zoom % in status bar')
      .setDesc('Display the current zoom level at the bottom; click it to reset to 100%.')
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showStatusBar).onChange(async (v) => {
          this.plugin.settings.showStatusBar = v;
          await this.plugin.saveSettings();
          this.plugin.updateStatusBar();
        })
      );

    new Setting(containerEl)
      .setName('Reset zoom')
      .setDesc('Set the zoom back to 100% now.')
      .addButton((b) =>
        b.setButtonText('Reset to 100%').onClick(() => this.plugin.setZoom(1.0))
      );
  }
}

/* nosourcemap */
