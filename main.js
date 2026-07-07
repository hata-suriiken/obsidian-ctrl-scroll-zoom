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
  step: 0.1, // zoom change per wheel notch, applied multiplicatively (0.1 = ×1.1)
  minZoom: 0.3, // lower clamp for the zoom factor
  maxZoom: 5.0, // upper clamp for the zoom factor
  modifier: 'ctrl', // 'ctrl' | 'meta' | 'alt'
  passThroughViews: true, // let Canvas/Excalidraw/PDF keep their own Ctrl+wheel zoom
  showStatusBar: true,
  zoomFactor: 1.0, // last applied zoom, restored on load
};

// Views that implement their own Ctrl+wheel zoom; when passThroughViews is on,
// wheel events originating inside these are left alone.
const PASS_THROUGH_SELECTOR = [
  '.canvas-wrapper', // core Canvas
  '.excalidraw-wrapper', // Excalidraw plugin
  '.excalidraw',
  '.pdf-container', // built-in PDF viewer
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
    this._gestureZoom = null;
    this._gestureTime = 0;
    await this.loadSettings();

    // Restore the zoom factor from the previous session.
    if (this.webFrame) {
      this.applyZoom(this.clamp(this.settings.zoomFactor));
    }

    // Status bar indicator (click to reset to 100%).
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('ctrl-scroll-zoom-status');
    this.statusEl.setAttribute('aria-label', 'Click to reset zoom to 100%');
    this.registerDomEvent(this.statusEl, 'click', () => this.setZoom(1.0));
    this.updateStatusBar();

    // Wheel handler on the main window, every existing pop-out window, and
    // any pop-out opened later.
    this.attachToWindow(window);
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const win = leaf.view?.containerEl?.ownerDocument?.defaultView;
        if (win) this.attachToWindow(win);
      });
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
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    // The wheel/click listeners are removed automatically (registerDomEvent).
    // Leave the current zoom as-is so the user's choice persists.
  }

  // Global Ctrl+wheel handler. Capture phase + non-passive so we can stop
  // the default scroll and beat any pane-local wheel handlers.
  attachToWindow(win) {
    if (!win || this._attachedWindows.has(win)) return;
    this._attachedWindows.add(win);
    this.registerDomEvent(
      win,
      'wheel',
      (evt) => this.onWheel(evt),
      { passive: false, capture: true }
    );
  }

  onWheel(evt) {
    if (!this.modifierHeld(evt)) return;
    if (!this.webFrame) return;
    if (evt.deltaY === 0) return;
    if (
      this.settings.passThroughViews &&
      evt.target instanceof Element &&
      evt.target.closest(PASS_THROUGH_SELECTOR)
    ) {
      return; // let Canvas/Excalidraw/PDF zoom themselves
    }
    evt.preventDefault();
    evt.stopPropagation();
    this.changeZoomSteps(-this.wheelSteps(evt), true);
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
    return this.webFrame ? this.webFrame.getZoomFactor() : this.settings.zoomFactor;
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
    this.applyZoom(clamped);
    this.settings.zoomFactor = clamped;
    this.updateStatusBar();
    this.debouncedSave();
  }

  // Pick up zoom changes made outside this plugin (built-in Ctrl+= / Ctrl+-).
  syncFromWebFrame() {
    if (!this.webFrame) return;
    const cur = Math.round(this.webFrame.getZoomFactor() * 10000) / 10000;
    if (cur !== this.settings.zoomFactor) {
      this.settings.zoomFactor = cur;
      this.debouncedSave();
    }
    this.updateStatusBar();
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    const visible = this.settings.showStatusBar && !!this.webFrame;
    this.statusEl.toggleClass('ctrl-scroll-zoom-hidden', !visible);
    if (visible) {
      const pct = Math.round(this.webFrame.getZoomFactor() * 100);
      this.statusEl.setText('🔍 ' + pct + '%');
    } else {
      this.statusEl.setText('');
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
      .setDesc('Upper bound, in percent (cannot go below the minimum).')
      .addSlider((s) =>
        s
          .setLimits(100, 500, 10)
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
      .setName('Let Canvas, Excalidraw and PDFs zoom themselves')
      .setDesc(
        'These views have their own Ctrl+scroll zoom. When enabled, scrolling over them keeps that behavior instead of zooming the whole app.'
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
