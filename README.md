# Ctrl+Scroll Zoom

Zoom the **whole Obsidian window** in and out with **Ctrl + mouse wheel**, just like a web browser or VS Code.

- **Ctrl + wheel up** → zoom in
- **Ctrl + wheel down** → zoom out
- **Trackpad pinch-to-zoom** also works (the browser reports a pinch as a Ctrl+wheel event).

Unlike image-only zoom plugins, this scales the entire app — UI and note text together — using Electron's page zoom.

## Features

- Smooth Ctrl+wheel zoom anywhere in the app (editor, sidebars, panes, **pop-out windows**).
- **Two zoom targets** (Settings → Zoom target): **Whole app** (default — UI included, like a browser) or **Note content only** — the ribbon, sidebars and tab bar stay at 100% and only the open note scales. Content zoom is frame-throttled and **anchored to the mouse cursor**, so the spot you point at stays put while you zoom.
- **Multiplicative zoom steps** — each notch scales by the same ratio (e.g. ×1.1), so zooming feels consistent at 50% and at 300%.
- **Smooth trackpad pinch** — pinch deltas zoom proportionally instead of jumping a full step per event.
- **Plays nice with Canvas, Excalidraw and the PDF viewer** — Ctrl+scroll over these keeps their own canvas zoom (can be turned off in settings).
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

The plugin listens for `wheel` events carrying the Ctrl modifier and adjusts the Electron renderer's zoom factor via `webFrame.setZoomFactor`. Because it relies on Electron, it is **desktop-only**.

## Notes

- This affects only the Obsidian window, not other applications.
- In **Note content only** mode the editor uses CSS `zoom`, so the in-editor cursor may sit slightly off at non-100% zoom (same caveat as the mobile companion plugin); the reading view is unaffected. PDFs keep their own built-in Ctrl+scroll zoom in this mode.
- It coexists with Obsidian's built-in `Ctrl +` / `Ctrl -` zoom.
- If you use *Mousewheel Image Zoom* with Ctrl as its modifier, the two may overlap while hovering an image; change one of the modifiers to avoid this.

## License

[MIT](LICENSE) © 2026 hata-suriiken
