# Splicer

**A focused photo tool: library, precision crop, automatic horizon leveling, and size-targeted export.**

Splicer does a few things and does them properly. It doesn't try to replace a full editor — it's built for the workflow of *straighten → crop → export at exactly the file size you need*, with a real photo library underneath.

![Splicer](https://img.shields.io/badge/version-2.2.0-f3c34f) ![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-1c1f26)

---

## Features

- **Photo library** that mirrors your real folders — import a folder once and it stays in sync with the disk automatically (add or remove files in Explorer/Finder and the library follows, even while the app is closed). Filter by star rating, an "Edited" view, or a specific folder; sort by date and resize thumbnails on the fly. Multi-select with `Ctrl`/`Shift`-click for batch level, batch export, or batch remove. Originals are **never modified** — every edit is non-destructive and reversible, and removing something from the library never deletes it from disk (there's a one-click Undo in the toast either way).
- **Precision crop**: aspect presets (Free, Original, 1:1, 3:2, 4:3, 16:9, 4:5 — flip any of them to their portrait/landscape counterpart), rule-of-thirds grid, quarter-turn rotation (`[` `]`) plus a fine ±45° leveling slider with auto-fill, hand tool, canvas zoom with deep-zoom sharpening for pixel-precise framing, full undo/redo history (`Ctrl+Z` / `Ctrl+Shift+Z`).
- **Auto horizon leveling** built on line detection (Hough transform ranked by line length) — one click, with alternative suggestions if the first guess is off, and a batch mode that levels a whole selection at once.
- **Size-targeted export**: type "9 MB" and Splicer binary-searches the encoder to land just under it. Powered by **MozJPEG** (best-in-class quality per byte) and high-effort WebP, with a live size estimate before you save — instant even on huge files, since the search runs on a downscaled preview and the result is scaled back up.
- **Export presets**: save "Telegram · ≤2 MB · JPEG → D:\Out" once, then right-click any photo(s) → one click and they're compressed and delivered to that folder. Filename templates (`{name}`, `{date}`) and optional EXIF carry-over included.
- **Big-file ready**: a proxy pyramid keeps 200-megapixel files panning and zooming as smoothly as phone photos, with on-demand full-resolution tiles the moment you zoom in past the proxy's own sharpness.
- **Wide format support**: JPEG, PNG, WebP, GIF, AVIF, BMP, TIFF, HEIC/HEIF and camera RAW (CR2, CR3, NEF, ARW, ORF, RW2, RAF, DNG, PEF and more).
- Star ratings with keyboard shortcuts, an EXIF panel (camera, lens, ISO, shutter speed, aperture, focal length, capture date), dark & light themes, drag-and-drop import straight from the OS.

Everything runs **100% locally**. No accounts, no cloud, no telemetry — your photos never leave your computer.

---

## Download & install

Grab the file for your system from the **[latest release](../../releases/latest)**.

| System | File | Notes |
|---|---|---|
| **Windows 10/11** | `Splicer Setup X.X.X.exe` | Regular installer |
| **macOS — Apple Silicon** | `Splicer-X.X.X-arm64.dmg` | M1–M4 Macs |
| **macOS — Intel** | `Splicer-X.X.X-x64.dmg` | |
| **Linux** | `Splicer-X.X.X.AppImage` | No installation needed |

The app is not code-signed with a paid certificate, so each OS shows a one-time warning on first launch. This is expected — here's how to get past it:

### Windows
1. Run the `.exe`. If **SmartScreen** appears ("Windows protected your PC"): click **More info → Run anyway**.
2. Follow the installer. Launch Splicer from the Start menu.

### macOS
1. Open the `.dmg` and drag **Splicer** into **Applications**.
2. First launch: **right-click the app → Open → Open** (a plain double-click will be blocked once).
3. If macOS says the app *"is damaged and can't be opened"* — it isn't damaged, it's the quarantine flag on unsigned downloads. Open **Terminal** and run:
   ```
   xattr -cr /Applications/Splicer.app
   ```
   then launch normally.

### Linux
```bash
chmod +x Splicer-*.AppImage
./Splicer-*.AppImage
```
If it complains about FUSE: `sudo apt install libfuse2`.

---

## Quick start

1. **Import folder** — pick a folder of photos; it appears in the sidebar and stays in sync with the disk.
2. Click a photo → it opens in the **viewer**. Press **Crop** (or `Enter`) for the tools.
3. Hit **Auto level**, fine-tune with the slider or the suggested alternatives, adjust the frame, press **Done** (`Enter`).
4. **Export** → set the max size in MB, watch the live estimate, save. Or create a **preset** and from then on just right-click photo(s) → one click.

For a batch of photos: `Ctrl`/`Shift`-click to select several in the library grid, then use **Level**, **Export**, or **Remove** in the toolbar that appears.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | Open crop tools / apply crop |
| `Esc` | Apply & return to library |
| `←` `→` | Previous / next photo |
| `[` `]` | Rotate crop frame 90° left / right |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo crop steps |
| `1`–`5`, `0` | Rate photo / clear rating |
| Mouse wheel | Zoom the canvas |
| Drag empty space | Pan · double-click to fit the frame to the window |
| `Ctrl+Click`, `Shift+Click` | Select photos / select a range |

### Good to know

- **Removing photos or folders from the library never deletes files from disk** — and there's an Undo button in the toast just in case.
- Deep-zoomed view sharpens to true 1:1 pixels a moment after you stop zooming — that's the tile engine catching up with the proxy.
- If the export estimate says *"Maximum quality reached"*, your size limit is generous: quality 100 is already smaller than the limit, and extra bytes wouldn't add detail.

---

## Building from source

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/helgiforest/splicer.git
cd splicer
npm install
npm start          # build & run
npm run dist       # create the installer for your OS in release/
```

Tech: Electron + React + Vite; sharp/libvips with MozJPEG for encoding; dcraw (in a worker thread) for RAW development; Hough-transform horizon detection.
