# Splicer app icon (final)

Final icon: cut film strip on cream background. Files: splicer-{16,32,64,128,256,512,1024}.png.

## Instructions for Claude Code
- **macOS (.icns):** build an `icon.iconset` (icon_16x16.png … icon_512x512@2x.png from these sizes), then `iconutil -c icns icon.iconset -o splicer.icns`.
- **Windows (.ico):** `magick splicer-256.png splicer-128.png splicer-64.png splicer-32.png splicer-16.png splicer.ico`.
- **Linux:** install PNGs to `hicolor/{size}x{size}/apps/splicer.png` and reference `splicer` in the .desktop file.

Wire into the packaging config of https://github.com/helgiforest/splicer.
