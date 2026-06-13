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
  step: 0.1, // zoom factor change per wheel notch (0.1 = 10%)
  minZoom: 0.3, // lower clamp for the zoom factor
  maxZoom: 5.0, // upper clamp for the zoom factor
  showStatusBar: true,
  zoomFactor: 1.0, // last applied zoom, restored on load
};

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

    // Global Ctrl+wheel handler. Capture phase + non-passive so we can stop
    // the default scroll and beat any pane-local wheel handlers.
    this.registerDomEvent(
      window,
      'wheel',
      (evt) => {
        if (!evt.ctrlKey) return;
        if (!this.webFrame) return;
        if (evt.deltaY === 0) return;
        evt.preventDefault();
        evt.stopPropagation();
        const dir = evt.deltaY < 0 ? 1 : -1; // wheel up -> zoom in
        this.changeZoom(dir * this.settings.step);
      },
      { passive: false, capture: true }
    );

    // Command palette entries (also assignable to hotkeys).
    this.addCommand({
      id: 'zoom-in',
      name: 'Zoom in',
      callback: () => this.changeZoom(this.settings.step),
    });
    this.addCommand({
      id: 'zoom-out',
      name: 'Zoom out',
      callback: () => this.changeZoom(-this.settings.step),
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

  clamp(z) {
    if (isNaN(z)) return 1.0;
    return Math.min(this.settings.maxZoom, Math.max(this.settings.minZoom, z));
  }

  applyZoom(z) {
    if (this.webFrame) this.webFrame.setZoomFactor(z);
  }

  changeZoom(delta) {
    const cur = this.webFrame ? this.webFrame.getZoomFactor() : this.settings.zoomFactor;
    this.setZoom(cur + delta);
  }

  setZoom(z) {
    const clamped = this.clamp(z);
    this.applyZoom(clamped);
    this.settings.zoomFactor = clamped;
    this.updateStatusBar();
    this.debouncedSave();
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
      .setDesc('How much the zoom factor changes per wheel notch (0.1 = 10%).')
      .addText((t) =>
        t
          .setPlaceholder('0.1')
          .setValue(String(this.plugin.settings.step))
          .onChange(async (v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.step = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Minimum zoom')
      .setDesc('Lower bound for the zoom factor (1.0 = 100%).')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.minZoom)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.minZoom = n;
            await this.plugin.saveSettings();
          }
        })
      );

    new Setting(containerEl)
      .setName('Maximum zoom')
      .setDesc('Upper bound for the zoom factor (1.0 = 100%).')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxZoom)).onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxZoom = n;
            await this.plugin.saveSettings();
          }
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
