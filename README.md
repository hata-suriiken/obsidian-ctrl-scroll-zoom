# Ctrl+Scroll Zoom

Zoom your notes in and out with **Ctrl + mouse wheel**, just like a web browser or VS Code.

- **Ctrl + wheel up** → zoom in
- **Ctrl + wheel down** → zoom out
- **Trackpad pinch-to-zoom** also works (the browser reports a pinch as a Ctrl+wheel event).

Unlike image-only zoom plugins, this scales the whole note — text, images and diagrams together. By default only the **note content** zooms while the ribbon, sidebars and tab bar stay at 100%; a **Whole app** mode (Electron page zoom, UI included) is available in settings.

## Features

- Smooth Ctrl+wheel zoom anywhere in the app (editor, sidebars, panes, **pop-out windows**).
- **Two zoom targets** (Settings → Zoom target): **Note content only** (default since v1.4.0) — the ribbon, sidebars and tab bar stay at 100% and only the open note scales (text and images together) — or **Whole app** (UI included, like a browser). Content zoom is frame-throttled and **anchored to the mouse cursor**, so the spot you point at stays put while you zoom.
- **Multiplicative zoom steps** — each notch scales by the same ratio (e.g. ×1.1), so zooming feels consistent at 50% and at 300%.
- **Smooth trackpad pinch** — pinch deltas zoom proportionally instead of jumping a full step per event.
- **Plays nice with Canvas and Excalidraw** — Ctrl+scroll over these keeps their own spatial zoom (can be turned off in settings). PDFs zoom themselves in Note content mode; in Whole app mode the app zoom applies above PDFs too.
- **PDF-aware indicator** — while a PDF is the active view, the status bar shows the PDF's own zoom (e.g. `🔍 PDF 80%`) and clicking it resets the PDF to 100% too.
- Choice of **modifier key**: Ctrl, Cmd/Win, or Alt/Option.
- Zoom level **persists across restarts**, and the indicator stays in sync with Obsidian's built-in `Ctrl +` / `Ctrl -` zoom.
- Status-bar indicator showing the current zoom %; **click it to reset to 100%**.
- Command-palette commands: **Zoom in**, **Zoom out**, **Reset zoom to 100%** (assignable to hotkeys).
- Slider settings for zoom step and min/max limits, plus an option to hide the status-bar indicator.

## Installation

### From Community Plugins (once approved)

Settings → Community plugins → Browse → search **"Ctrl+Scroll Zoom"** → Install → Enable.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/hata-suriiken/obsidian-ctrl-scroll-zoom/releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/ctrl-scroll-zoom/`.
3. Reload Obsidian, then enable **Ctrl+Scroll Zoom** under Settings → Community plugins.

### Via BRAT

Add `hata-suriiken/obsidian-ctrl-scroll-zoom` in the BRAT plugin to track beta releases.

## Usage

Hold **Ctrl** and scroll the mouse wheel: up to enlarge, down to shrink. You can also use the status-bar **🔍 nnn%** indicator (click to reset) or the commands listed above.

## How it works

The plugin listens for `wheel` events carrying the Ctrl modifier. In the default **Note content only** mode it scales the open note with CSS `zoom`; in **Whole app** mode it adjusts the Electron renderer's zoom factor via `webFrame.setZoomFactor`. It is **desktop-only** (mobile has the companion plugin below).

> Upgrading from ≤ 1.3.x: the default zoom target changed from Whole app to Note content only, and existing installs are migrated once. If you prefer the old behavior, set Settings → Zoom target back to **Whole app**.

## Notes

- This affects only the Obsidian window, not other applications.
- In **Note content only** mode the editor uses CSS `zoom`, so the in-editor cursor may sit slightly off at non-100% zoom (same caveat as the mobile companion plugin); the reading view is unaffected. PDFs keep their own built-in Ctrl+scroll zoom in this mode.
- It coexists with Obsidian's built-in `Ctrl +` / `Ctrl -` zoom.
- If you use *Mousewheel Image Zoom* with Ctrl as its modifier, the two may overlap while hovering an image; change one of the modifiers to avoid this.

## License

[MIT](LICENSE) © 2026 hata-suriiken
