import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";

/* ============================================================
   MERIDIAN — a focused photo tool (desktop build)
   Library (Photomator-style) + best-in-class crop,
   auto horizon leveling, and target-file-size export.

   Runs inside Electron (persistent library, real folders on
   disk) and falls back to pure-browser mode when the native
   bridge is absent.
   ============================================================ */

const NATIVE = typeof window !== "undefined" && !!window.meridian;
const photoURL = (absPath) => `photo://${encodeURIComponent(absPath)}`;
const thumbURL = (p) => (NATIVE && p.path ? `${photoURL(p.path)}?thumb` : p.url);
const proxyURL = (p) => (NATIVE && p.path ? `${photoURL(p.path)}?proxy` : p.url);
const PROXY_LONG = 3200;

/* bake a small edited preview from the PROXY (fast even for 200-MP files) */
async function bakePreview(srcUrl, origW, origH, edits, maxDim = 560) {
  const img = await loadImage(srcUrl);
  const s0 = img.naturalWidth / origW; // proxy px per original px
  const e = edits || { theta: 0, qcx: 0, qcy: 0, cw: origW, ch: origH };
  let outW = e.cw * s0, outH = e.ch * s0;
  const cap = maxDim / Math.max(outW, outH);
  if (cap < 1) { outW *= cap; outH *= cap; }
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outH));
  const s = outW / e.cw;
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.scale(s / s0, s / s0);
  ctx.rotate(rad(e.theta));
  ctx.translate(-e.qcx * s0, -e.qcy * s0);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvas.toDataURL("image/jpeg", 0.82);
}
const isUnder = (p, root) => {
  if (!p || !root) return false;
  const np = p.replace(/\\/g, "/");
  const nr = root.replace(/\\/g, "/");
  return np.startsWith(nr) && (np.length === nr.length || np[nr.length] === "/");
};
const baseName = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p;

const CSS = `
:root {
  --bg: #0B0C0F;
  --surface: #14161B;
  --raised: #1C1F26;
  --stroke: #2A2E37;
  --stroke-soft: #22252d;
  --text: #E9EBEF;
  --muted: #8B909C;
  --faint: #5B606C;
  --accent: #F3C34F;
  --accent-ink: #241A03;
  --danger: #F26D6D;
  --hover: #232733;
  --seg-on: #262b36;
  --strip: #101217;
  --dim: rgba(8,9,11,.72);
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
.app {
  font-family: var(--sans);
  background: var(--bg);
  color: var(--text);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
.app.light {
  --bg: #F2F2F5;
  --surface: #FFFFFF;
  --raised: #EBECEF;
  --stroke: #D6D9E0;
  --stroke-soft: #E5E7EC;
  --text: #1C1E24;
  --muted: #5C6270;
  --faint: #979DA9;
  --accent: #E0A21F;
  --accent-ink: #241A03;
  --danger: #D64545;
  --hover: #E2E4E9;
  --seg-on: #FFFFFF;
  --strip: #E9EAEE;
  --dim: rgba(238,239,242,.8);
}
button { font-family: inherit; cursor: pointer; }
input, select { font-family: inherit; }

/* ---------- top bar ---------- */
.topbar {
  height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  border-bottom: 1px solid var(--stroke-soft);
  background: var(--surface);
  flex-shrink: 0;
}
.brand {
  display: flex; align-items: baseline; gap: 8px;
  margin-right: 8px; user-select: none;
}
.brand .name { font-weight: 700; letter-spacing: 0.14em; font-size: 13px; }
.brand .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); align-self: center; }
.spacer { flex: 1; }

.btn {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--raised);
  color: var(--text);
  border: 1px solid var(--stroke);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
  transition: background .15s, border-color .15s, opacity .15s;
  white-space: nowrap;
}
.btn:hover { background: var(--hover); }
.btn:disabled { opacity: .4; cursor: default; }
.btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }
.btn.primary:hover { background: #f8cf6e; }
.btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn.ghost:hover { color: var(--text); background: var(--raised); }
.btn.danger { color: var(--danger); }
.btn.active { border-color: var(--accent); color: var(--accent); }
.btn svg { flex-shrink: 0; }

.thumbslider { display: flex; align-items: center; gap: 8px; color: var(--faint); }

/* ---------- layout ---------- */
.body { flex: 1; display: flex; min-height: 0; }
.sidebar {
  width: 208px; flex-shrink: 0;
  border-right: 1px solid var(--stroke-soft);
  background: var(--surface);
  padding: 14px 10px;
  overflow-y: auto;
}
.side-label {
  font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--faint); padding: 14px 10px 6px;
}
.side-item {
  display: flex; align-items: center; gap: 9px;
  width: 100%; text-align: left;
  padding: 7px 10px; border-radius: 7px;
  background: transparent; border: none; color: var(--muted);
  font-size: 13px;
}
.side-item:hover { background: var(--raised); color: var(--text); }
.side-item.active { background: var(--raised); color: var(--text); }
.side-item .count { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--faint); }
.side-rating { display: flex; align-items: center; gap: 1px; padding: 2px 10px 4px; }
.side-rating button {
  background: none; border: none; padding: 2px; font-size: 15px; line-height: 1;
  color: var(--faint); transition: color .1s;
}
.side-rating button:hover { color: var(--muted); }
.side-rating button.lit { color: var(--accent); }
.side-rating .clear { margin-left: 4px; font-size: 11px; display: inline-flex; }
.side-item svg { flex-shrink: 0; opacity: .8; }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.gridwrap { flex: 1; overflow-y: auto; padding: 18px; }
.grid { display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(var(--cell), 1fr)); }

.cell {
  position: relative; border-radius: 6px; overflow: hidden;
  background: linear-gradient(110deg, var(--raised) 40%, var(--hover) 50%, var(--raised) 60%);
  background-size: 200% 100%;
  animation: shimmer 1.5s linear infinite;
  cursor: pointer;
  outline: 2px solid transparent; outline-offset: -2px;
  transition: outline-color .12s;
}
.cell img { width: 100%; height: 100%; object-fit: cover; display: block; }
.cell.selected { outline-color: var(--accent); }
.cell .check {
  position: absolute; top: 8px; left: 8px; width: 21px; height: 21px;
  border-radius: 50%; border: 1.5px solid rgba(255,255,255,.85);
  background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .12s;
}
.cell:hover .check, .cell.selectmode .check { opacity: 1; }
.cell.selected .check { background: var(--accent); border-color: var(--accent); }
.badge {
  position: absolute; bottom: 7px; right: 7px;
  background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
  border-radius: 5px; padding: 3px 6px;
  font-size: 9px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--accent); font-weight: 600;
}

.empty {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; color: var(--muted); text-align: center; padding: 40px;
}
.empty h2 { font-weight: 600; font-size: 17px; color: var(--text); }
.empty p { max-width: 340px; line-height: 1.55; font-size: 13px; }
.empty .row { display: flex; gap: 10px; margin-top: 6px; }

.dropveil {
  position: absolute; inset: 10px; border: 2px dashed var(--accent); border-radius: 14px;
  background: rgba(243,195,79,.06); z-index: 40; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
  color: var(--accent); font-weight: 600; letter-spacing: .04em;
}

/* ---------- editor ---------- */
.editor { position: fixed; inset: 0; background: var(--bg); display: flex; flex-direction: column; z-index: 100; }
.editor .topbar { border-bottom-color: var(--stroke-soft); }
.ed-body { flex: 1; display: flex; min-height: 0; }
.stage { flex: 1; position: relative; overflow: hidden; min-height: 0; cursor: grab; }
.stage:active { cursor: grabbing; }

/* ---------- metadata panel ---------- */
.meta {
  width: 236px; flex-shrink: 0;
  border-left: 1px solid var(--stroke-soft); background: var(--surface);
  padding: 16px 16px 12px; overflow-y: auto; font-size: 12px;
}
.meta h4 {
  font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--faint); font-weight: 600; margin: 16px 0 8px;
}
.meta h4:first-child { margin-top: 0; }
.meta .mrow { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; }
.meta .mrow .k { color: var(--faint); flex-shrink: 0; }
.meta .mrow .v { color: var(--text); font-family: var(--mono); font-size: 11.5px; text-align: right; overflow-wrap: anywhere; }
.meta .fname { color: var(--text); font-size: 12.5px; overflow-wrap: anywhere; line-height: 1.4; margin-bottom: 2px; }
.meta .divider { height: 1px; background: var(--stroke-soft); margin: 14px 0; }

.stars { display: inline-flex; gap: 2px; }
.stars button {
  background: none; border: none; padding: 0 1px; font-size: 17px; line-height: 1;
  color: var(--faint); transition: color .1s, transform .1s;
}
.stars button:hover { transform: scale(1.15); }
.stars button.lit { color: var(--accent); }
.stars.readonly { pointer-events: none; }
.stars.readonly button { font-size: 9px; padding: 0; }

/* ---------- filmstrip ---------- */
.filmstrip {
  flex-shrink: 0; height: 92px;
  border-top: 1px solid var(--stroke-soft); background: var(--strip);
  display: flex; align-items: center; gap: 6px;
  overflow-x: auto; overflow-y: hidden; padding: 8px 12px;
  scrollbar-width: thin;
}
.filmstrip::-webkit-scrollbar { height: 7px; }
.strip-item {
  position: relative; height: 100%; aspect-ratio: 1; flex-shrink: 0;
  border-radius: 5px; overflow: hidden; cursor: pointer;
  outline: 2px solid transparent; outline-offset: -2px;
  transition: outline-color .12s; background: var(--raised);
}
.strip-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.strip-item.current { outline-color: var(--accent); }
.strip-item.sel { outline-color: #4B9BFF; }
.strip-item.sel img { opacity: .75; }
.strip-item .scheck {
  position: absolute; top: 4px; left: 4px; width: 17px; height: 17px;
  border-radius: 50%; background: #4B9BFF;
  display: flex; align-items: center; justify-content: center;
}
.strip-item .scheck svg path { stroke: #fff; }
.strip-item .sinfo {
  position: absolute; left: 0; right: 0; bottom: 0;
  background: linear-gradient(transparent, rgba(0,0,0,.75));
  padding: 10px 5px 3px; display: flex; justify-content: space-between; align-items: flex-end;
  font-size: 9px; font-family: var(--mono); color: rgba(255,255,255,.85);
}
.strip-item .sstars { color: var(--accent); letter-spacing: -1px; font-size: 9px; }
.strip-item .sedit {
  position: absolute; top: 4px; right: 4px; width: 6px; height: 6px;
  border-radius: 50%; background: var(--accent);
}

/* sidebar sync toggle */
.side-item .synctoggle {
  display: none; margin-left: 4px; flex-shrink: 0;
  background: none; border: none; color: var(--faint); padding: 2px;
  border-radius: 4px; line-height: 0;
}
.side-item:hover .synctoggle { display: inline-flex; }
.side-item .synctoggle:hover { color: var(--accent); background: rgba(243,195,79,.12); }
.side-item .synctoggle.danger:hover { color: var(--danger); background: rgba(242,109,109,.12); }

/* rating badge on library cells */
.rbadge {
  position: absolute; bottom: 7px; left: 7px;
  background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
  border-radius: 5px; padding: 2px 5px;
  font-size: 9px; color: var(--accent); letter-spacing: -0.5px;
}
.imgspace {
  position: absolute; left: 0; top: 0; transform-origin: center;
  user-select: none; pointer-events: none;
}
.imgspace .base {
  position: absolute; inset: 0; width: 100%; height: 100%;
  user-select: none; pointer-events: none; max-width: none;
}
.imgspace .tileimg {
  position: absolute; user-select: none; pointer-events: none; max-width: none;
  transition: opacity .18s ease;
}
/* promoted to its own GPU layer only WHILE zooming/panning: buttery motion
   during the gesture, full-quality re-raster the moment it ends */
.imgspace.gpu { will-change: transform; }
.cropframe {
  position: absolute; border: 1px solid rgba(255,255,255,.9);
  box-shadow: 0 0 0 9999px var(--dim);
  cursor: grab; touch-action: none;
}
.cropframe.grabbing { cursor: grabbing; }
.viewclip {
  position: absolute; overflow: hidden;
  box-shadow: 0 12px 48px rgba(0,0,0,.35);
}

.anim .imgspace { transition: transform .32s cubic-bezier(.3,.9,.3,1); will-change: transform; }
.world { position: absolute; inset: 0; transform-origin: 0 0; }


.thirds { position: absolute; inset: 0; opacity: 0; transition: opacity .18s; pointer-events: none; }
.thirds.on { opacity: 1; }
.thirds .v, .thirds .h { position: absolute; background: rgba(255,255,255,.35); }
.thirds .v { top: 0; bottom: 0; width: 1px; }
.thirds .h { left: 0; right: 0; height: 1px; }

.handle { position: absolute; touch-action: none; }
.handle.corner { width: 22px; height: 22px; }
.handle.corner::before, .handle.corner::after {
  content: ""; position: absolute; background: #fff; border-radius: 2px;
}
.handle.corner::before { width: 16px; height: 3px; }
.handle.corner::after { width: 3px; height: 16px; }
.h-nw { left: -5px; top: -5px; cursor: nwse-resize; } .h-nw::before { left: 5px; top: 5px; } .h-nw::after { left: 5px; top: 5px; }
.h-ne { right: -5px; top: -5px; cursor: nesw-resize; } .h-ne::before { right: 5px; top: 5px; } .h-ne::after { right: 5px; top: 5px; }
.h-sw { left: -5px; bottom: -5px; cursor: nesw-resize; } .h-sw::before { left: 5px; bottom: 5px; } .h-sw::after { left: 5px; bottom: 5px; }
.h-se { right: -5px; bottom: -5px; cursor: nwse-resize; } .h-se::before { right: 5px; bottom: 5px; } .h-se::after { right: 5px; bottom: 5px; }
.handle.edge { background: transparent; }
.h-n { left: 24px; right: 24px; top: -6px; height: 12px; cursor: ns-resize; }
.h-s { left: 24px; right: 24px; bottom: -6px; height: 12px; cursor: ns-resize; }
.h-e { top: 24px; bottom: 24px; right: -6px; width: 12px; cursor: ew-resize; }
.h-w { top: 24px; bottom: 24px; left: -6px; width: 12px; cursor: ew-resize; }
.h-n::after, .h-s::after { content: ""; position: absolute; left: 50%; transform: translateX(-50%); width: 26px; height: 3px; background: #fff; border-radius: 2px; }
.h-n::after { top: 4px; } .h-s::after { bottom: 4px; }
.h-e::after, .h-w::after { content: ""; position: absolute; top: 50%; transform: translateY(-50%); width: 3px; height: 26px; background: #fff; border-radius: 2px; }
.h-e::after { right: 4px; } .h-w::after { left: 4px; }

.toolbelt {
  flex-shrink: 0; border-top: 1px solid var(--stroke-soft); background: var(--surface);
  padding: 12px 18px 16px; display: flex; flex-direction: column; gap: 12px;
}
.aspects { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; justify-content: center; }
.chip {
  background: transparent; border: 1px solid var(--stroke); color: var(--muted);
  border-radius: 999px; padding: 5px 13px; font-size: 12px;
  transition: all .12s;
}
.chip:hover { color: var(--text); border-color: var(--faint); }
.chip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.chip.icon { padding: 5px 9px; display: inline-flex; }
.chip:disabled { opacity: .35; cursor: default; pointer-events: none; }

.rot-row { display: flex; align-items: center; gap: 14px; max-width: 620px; margin: 0 auto; width: 100%; }
.level-opts {
  display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap;
  animation: toastin .2s ease;
}
.level-opts .lo-label {
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--faint); margin-right: 4px;
}
.level-opts .lo-close {
  background: none; border: none; color: var(--faint); padding: 4px; line-height: 0;
  border-radius: 4px;
}
.level-opts .lo-close:hover { color: var(--text); background: var(--raised); }
.rot-slider { flex: 1; position: relative; height: 26px; display: flex; align-items: center; }
.rot-slider .notch { position: absolute; left: 50%; top: 0; width: 1px; height: 7px; background: var(--faint); }
input[type="range"].rot {
  -webkit-appearance: none; width: 100%; height: 3px; border-radius: 2px;
  background: var(--stroke); outline: none;
}
input[type="range"].rot::-webkit-slider-thumb {
  -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; border: none; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer;
}
input[type="range"].rot::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%; background: #fff; border: none; cursor: pointer;
}
.degree {
  font-family: var(--mono); font-size: 13px; color: var(--text);
  width: 64px; text-align: right; font-variant-numeric: tabular-nums;
}
.degree.zero { color: var(--faint); }

/* ---------- dialog ---------- */
.veil {
  position: fixed; inset: 0; background: rgba(5,6,8,.66); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.dialog {
  width: 380px; max-width: calc(100vw - 32px);
  background: var(--surface); border: 1px solid var(--stroke);
  border-radius: 14px; padding: 22px; box-shadow: 0 24px 60px rgba(0,0,0,.5);
}
.dialog h3 { font-size: 16px; font-weight: 600; margin-bottom: 3px; letter-spacing: -.01em; }
.dialog .sub { color: var(--faint); font-size: 12px; margin-bottom: 18px; font-family: var(--mono); }
.field { margin-bottom: 13px; }
.field label { display: block; font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); margin-bottom: 7px; }
.field .controls { display: flex; gap: 8px; }
.seg { display: flex; background: var(--raised); border: 1px solid var(--stroke); border-radius: 8px; overflow: hidden; flex: 1; }
.seg button {
  flex: 1; background: transparent; border: none; color: var(--muted);
  padding: 7px 0; font-size: 13px;
}
.seg button.on { background: var(--seg-on); color: var(--text); font-weight: 600; }
.numinput {
  display: flex; align-items: center; gap: 8px;
  background: var(--raised); border: 1px solid var(--stroke); border-radius: 8px;
  padding: 7px 12px; flex: 1;
}
.numinput input {
  background: transparent; border: none; outline: none; color: var(--text);
  width: 100%; font-size: 13.5px; font-family: var(--mono);
}
.numinput .unit { color: var(--faint); font-size: 11.5px; flex-shrink: 0; }
.estimate {
  background: var(--raised); border: 1px solid var(--stroke-soft); border-radius: 10px;
  padding: 11px 14px; margin: 14px 0; font-size: 12.5px; color: var(--muted);
  min-height: 40px; display: flex; align-items: center; gap: 10px; line-height: 1.4;
}
.estimate strong { color: var(--text); font-family: var(--mono); font-weight: 600; }
.estimate.warn { color: var(--danger); border-color: rgba(242,109,109,.35); }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.chk {
  display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
  font-size: 12px; color: var(--muted); cursor: pointer; padding: 0 4px;
}
.chk-row { display: flex; margin-top: 10px; }
.chk input { accent-color: var(--accent); width: 14px; height: 14px; cursor: pointer; margin: 0 8px 0 0; }
.preset-list { display: flex; flex-direction: column; gap: 6px; }
.preset-row {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  background: var(--raised); border: 1px solid var(--stroke); border-radius: 8px;
  padding: 9px 12px; text-align: left; transition: border-color .12s, background .12s;
}
.preset-row:hover { border-color: var(--accent); background: var(--hover); }
.preset-row:disabled { opacity: .5; }
.preset-row .cm-name { font-size: 13px; color: var(--text); font-weight: 500; }
.preset-row .cm-sub { font-size: 11px; color: var(--faint); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: var(--raised); border: 1px solid var(--stroke);
  border-radius: 10px; padding: 10px 18px; font-size: 13px; z-index: 300;
  box-shadow: 0 10px 30px rgba(0,0,0,.45); color: var(--text);
  animation: toastin .22s ease;
}
.ctxmenu {
  position: fixed; z-index: 400; min-width: 240px; max-width: 320px;
  background: var(--surface); border: 1px solid var(--stroke);
  border-radius: 10px; padding: 6px; box-shadow: 0 16px 48px rgba(0,0,0,.45);
  animation: menuin .13s ease;
}
@keyframes menuin { from { opacity: 0; } to { opacity: 1; } }
.ctxmenu .cm-title {
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--faint); padding: 6px 10px 4px;
}
.ctxmenu .cm-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 7px; cursor: pointer;
}
.ctxmenu .cm-item:hover { background: var(--raised); }
.ctxmenu .cm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ctxmenu .cm-name { font-size: 13px; color: var(--text); }
.ctxmenu .cm-sub { font-size: 10.5px; color: var(--faint); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctxmenu .cm-del {
  background: none; border: none; color: var(--faint); padding: 4px; line-height: 0; border-radius: 5px;
}
.ctxmenu .cm-del:hover { color: var(--danger); background: rgba(242,109,109,.12); }
.ctxmenu .cm-sep { height: 1px; background: var(--stroke-soft); margin: 5px 6px; }
.ctxmenu .cm-empty { padding: 8px 10px; font-size: 12px; color: var(--faint); }
@keyframes shimmer { to { background-position: -200% 0; } }
@keyframes toastin { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.toast { display: flex; align-items: center; gap: 12px; }
.toast .toast-act {
  background: none; border: none; color: var(--accent); font-weight: 600;
  font-size: 13px; padding: 0; text-transform: uppercase; letter-spacing: .05em;
}
.toast .toast-act:hover { text-decoration: underline; }

.spin { width: 14px; height: 14px; border: 2px solid var(--stroke); border-top-color: var(--accent); border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0; }
@keyframes spin { to { transform: rotate(360deg); } }

::-webkit-scrollbar { width: 10px; }
::-webkit-scrollbar-thumb { background: var(--stroke); border-radius: 5px; border: 2px solid var(--bg); }
::-webkit-scrollbar-track { background: transparent; }
@media (prefers-reduced-motion: reduce) {
  .anim .stage-img, .anim .cropframe, .toast { transition: none !important; animation: none !important; }
}
`;

/* ============ small utils ============ */
let __id = 0;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `p${++__id}_${Date.now()}`);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = (d) => (d * Math.PI) / 180;
const rot = (x, y, t) => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
const irot = (x, y, t) => rot(x, y, -t);
const fmtMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2) + " MB";
const fmtSize = (bytes) => {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
};

/* Reconstruct the folder root that a photo was imported from:
   photo.path = <prefix>/<rootName>/<sub...>/<name>, photo.folder = <rootName>/<sub...> */
function deriveRoot(photo) {
  if (!photo?.path || !photo.folder) return null;
  const norm = photo.path.replace(/\\/g, "/");
  const tail = `${photo.folder}/${photo.name}`;
  if (!norm.endsWith(tail)) return null;
  const prefix = norm.slice(0, norm.length - tail.length); // ends with '/'
  return prefix + photo.folder.split("/")[0];
}

const imgCache = new Map();
const exifCache = new Map();
function loadImage(url) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
  imgCache.set(url, p);
  return p;
}

function toBlobAsync(canvas, type, quality) {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/* ------------------------------------------------------------------
   Fast target-size solver.
   Encoding a full-resolution canvas 8-9 times (naive binary search)
   is what made the estimate slow. Instead:
     1. binary-search quality on a small proxy copy (encodes in ms),
        scaling the byte target by the pixel ratio;
     2. verify with 1-3 encodes of the real canvas, nudging quality
        with a secant step if the first guess overshoots;
     3. cache every measurement, so changing the MB value reuses
        already-known (quality → size) points instead of re-encoding.
   ------------------------------------------------------------------ */
const Q_MIN = 0.05, Q_MAX = 0.97;

function makeSizeSolver(canvas, mime) {
  const proxyPts = new Map(); // quality(fixed3) -> bytes
  const fullPts = new Map();  // quality(fixed3) -> { size, blob }
  let proxy = null;

  const ensureProxy = () => {
    if (proxy) return proxy;
    const long = Math.max(canvas.width, canvas.height);
    if (long <= 1400) { proxy = canvas; return proxy; }
    const f = 1400 / long;
    const p = document.createElement("canvas");
    p.width = Math.max(1, Math.round(canvas.width * f));
    p.height = Math.max(1, Math.round(canvas.height * f));
    const ctx = p.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, p.width, p.height);
    proxy = p;
    return proxy;
  };

  const measureProxy = async (q) => {
    const key = q.toFixed(3);
    if (proxyPts.has(key)) return proxyPts.get(key);
    const b = await toBlobAsync(ensureProxy(), mime, q);
    const size = b ? b.size : Infinity;
    proxyPts.set(key, size);
    return size;
  };

  const measureFull = async (q) => {
    const key = q.toFixed(3);
    if (fullPts.has(key)) return fullPts.get(key);
    const blob = await toBlobAsync(canvas, mime, q);
    const res = { size: blob ? blob.size : Infinity, blob };
    fullPts.set(key, res);
    return res;
  };

  return async function solve(targetBytes) {
    const p = ensureProxy();
    const ratio = (canvas.width * canvas.height) / (p.width * p.height);
    const proxyTarget = targetBytes / ratio;

    // 1) cheap binary search on the proxy
    let lo = Q_MIN, hi = Q_MAX;
    if ((await measureProxy(Q_MAX)) <= proxyTarget) {
      lo = Q_MAX;
    } else if ((await measureProxy(Q_MIN)) > proxyTarget) {
      lo = Q_MIN; // even minimum quality is too big — verify on full below
    } else {
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if ((await measureProxy(mid)) <= proxyTarget) lo = mid; else hi = mid;
      }
    }

    // 2) verify on the real canvas, nudging if needed
    let q = lo;
    let best = null;
    for (let i = 0; i < 4; i++) {
      const m = await measureFull(q);
      if (m.size <= targetBytes) {
        if (!best || m.size > best.size) best = { blob: m.blob, quality: q, over: false };
        break;
      }
      if (q <= Q_MIN + 1e-6) {
        return { blob: m.blob, quality: Q_MIN, over: true };
      }
      // secant-style step toward the target
      q = clamp(q * Math.pow(targetBytes / m.size, 0.9), Q_MIN, q - 0.02);
    }
    if (!best) {
      const m = await measureFull(Q_MIN);
      best = { blob: m.blob, quality: Q_MIN, over: m.size > targetBytes };
    }
    return best;
  };
}

/* Bake a photo (with its non-destructive edits) onto a canvas */
async function bakeCanvas(photo, edits, scalePct = 100, maxDim = Infinity) {
  const img = await loadImage(photo.url);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const e = edits || { theta: 0, qcx: 0, qcy: 0, cw: iw, ch: ih };
  let outW = e.cw * (scalePct / 100);
  let outH = e.ch * (scalePct / 100);
  const cap = maxDim / Math.max(outW, outH);
  if (cap < 1) { outW *= cap; outH *= cap; }
  outW = Math.max(1, Math.round(outW));
  outH = Math.max(1, Math.round(outH));
  const s = outW / e.cw;
  const canvas = document.createElement("canvas");
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, outW, outH);
  ctx.translate(outW / 2, outH / 2);
  ctx.scale(s, s);
  ctx.rotate(rad(e.theta));
  ctx.translate(-e.qcx, -e.qcy);
  ctx.drawImage(img, -iw / 2, -ih / 2);
  return canvas;
}

/* ------------------------------------------------------------------
   Horizon detection v2 — Hough transform over edge points.
   Instead of asking "which tilt do most edge pixels have" (texture
   easily pollutes that), we ask "where is the strongest single
   straight line", which is what a horizon actually is. Each edge
   pixel votes only for angles close to its own gradient orientation,
   and votes are binned by (angle, distance-from-origin). The best
   (angle, rho) cell = the longest/strongest near-horizontal line.
   The angle is then refined to sub-bin precision with a parabola fit.
   ------------------------------------------------------------------ */
const HOUGH_STEP = 0.25;                       // degrees per angle bin
const HOUGH_N = Math.round(90 / HOUGH_STEP) + 1; // -45..+45  → 361 bins
const RHO_STEP = 2;                            // px per rho bin

async function detectHorizonCandidates(url) {
  const img = await loadImage(url);
  const maxDim = 640;
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(3, Math.round(img.naturalWidth * s));
  const h = Math.max(3, Math.round(img.naturalHeight * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4)
    g[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;

  /* --- collect near-horizontal edge points --- */
  const px = [], py = [], pm = [], po = [];
  let magSum = 0, magCount = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -g[i - w - 1] + g[i - w + 1] - 2 * g[i - 1] + 2 * g[i + 1] - g[i + w - 1] + g[i + w + 1];
      const gy =
        -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      const mag = Math.hypot(gx, gy);
      if (mag < 50) continue;
      let o = (Math.atan2(gy, gx) * 180) / Math.PI + 90; // line orientation
      o = ((o % 180) + 180) % 180;
      if (o > 90) o -= 180;
      if (Math.abs(o) > 50) continue; // clearly vertical structure — skip
      px.push(x); py.push(y); pm.push(mag); po.push(o);
      magSum += mag; magCount++;
    }
  }
  if (magCount < 40) return [];

  // keep the strongest points if there are too many (speed)
  let thr = 0;
  if (magCount > 30000) {
    const sorted = [...pm].sort((a, b) => b - a);
    thr = sorted[30000];
  }
  // cap per-pixel contrast: a soft but LONG sea horizon must be able to
  // out-vote a short high-contrast edge (rocks, clothing, shadows)
  const magSortedAsc = [...pm].sort((a, b) => a - b);
  const magCap = (magSortedAsc[Math.floor(magSortedAsc.length / 2)] || 1) * 4;

  /* --- Hough accumulator: angle × rho --- */
  const diag = Math.hypot(w, h);
  const rhoN = Math.ceil((2 * diag) / RHO_STEP) + 2;
  const acc = new Float32Array(HOUGH_N * rhoN);
  const sinT = new Float32Array(HOUGH_N), cosT = new Float32Array(HOUGH_N);
  for (let a = 0; a < HOUGH_N; a++) {
    const t = rad(a * HOUGH_STEP - 45);
    sinT[a] = Math.sin(t); cosT[a] = Math.cos(t);
  }
  const SPREAD = Math.round(6 / HOUGH_STEP); // vote ±6° around own orientation
  for (let i = 0; i < px.length; i++) {
    if (pm[i] < thr) continue;
    const ownBin = Math.round((clamp(po[i], -45, 45) + 45) / HOUGH_STEP);
    const a0 = Math.max(0, ownBin - SPREAD);
    const a1 = Math.min(HOUGH_N - 1, ownBin + SPREAD);
    for (let a = a0; a <= a1; a++) {
      // line at angle θ: rho = -x·sinθ + y·cosθ  (distance along the normal)
      const rho = -px[i] * sinT[a] + py[i] * cosT[a];
      const r = Math.round((rho + diag) / RHO_STEP);
      acc[a * rhoN + r] += Math.min(pm[i], magCap);
    }
  }

  /* --- per-angle: strongest single line (3-bin rho window) + where it sits --- */
  const lineScore = new Float64Array(HOUGH_N);
  const lineRho = new Int32Array(HOUGH_N);
  for (let a = 0; a < HOUGH_N; a++) {
    const base = a * rhoN;
    let best = 0, bestR = 0;
    for (let r = 1; r < rhoN - 1; r++) {
      const v = acc[base + r - 1] + acc[base + r] + acc[base + r + 1];
      if (v > best) { best = v; bestR = r; }
    }
    lineScore[a] = best;
    lineRho[a] = bestR;
  }
  const angleOf = (a) => a * HOUGH_STEP - 45;

  /* --- confidence: dominant peak must beat ambient texture --- */
  const sortedScores = [...lineScore].sort((x, y) => x - y);
  const median = sortedScores[Math.floor(HOUGH_N / 2)];
  let rawTop = 0;
  for (let a = 0; a < HOUGH_N; a++) if (lineScore[a] > lineScore[rawTop]) rawTop = a;
  const meanMag = magSum / magCount;
  if (lineScore[rawTop] < Math.max(median * 1.8, 0.1 * w * meanMag)) return [];

  /* --- peak picking (local maxima, non-max suppression >= 2 degrees apart) --- */
  const locals = [];
  for (let a = 1; a < HOUGH_N - 1; a++) {
    if (lineScore[a] >= lineScore[a - 1] && lineScore[a] > lineScore[a + 1]) locals.push(a);
  }
  locals.sort((x, y) => lineScore[y] - lineScore[x]);
  const peaks = [];
  for (const a of locals) {
    if (peaks.every((p) => Math.abs(p - a) >= 8)) peaks.push(a);
    if (peaks.length >= 5) break;
  }
  // the best near-zero line always competes (levelness guard)
  let zeroA = -1;
  for (let a = 0; a < HOUGH_N; a++) {
    if (Math.abs(angleOf(a)) <= 0.3 && (zeroA < 0 || lineScore[a] > lineScore[zeroA])) zeroA = a;
  }
  if (zeroA >= 0 && peaks.every((p) => Math.abs(p - zeroA) >= 2)) peaks.push(zeroA);

  /* --- re-rank peaks by how much of the frame the line actually spans.
     A real horizon is LONG (it even continues behind people), while a
     high-contrast rock or clothing edge is short. Contrast is capped
     during voting, so here length - not punchiness - decides. --- */
  const evalPeak = (a) => {
    const t = rad(angleOf(a));
    const sn = Math.sin(t), cs = Math.cos(t);
    const rho0 = lineRho[a] * RHO_STEP - diag;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < px.length; i++) {
      if (pm[i] < thr) continue;
      if (Math.abs(po[i] - angleOf(a)) > 8) continue;
      const rho = -px[i] * sn + py[i] * cs;
      if (Math.abs(rho - rho0) > RHO_STEP * 2.5) continue;
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
    }
    const extent = maxX > minX ? (maxX - minX) / w : 0;
    // refine to sub-bin precision
    let refined = a;
    if (a > 0 && a < HOUGH_N - 1) {
      const s0 = lineScore[a - 1], s1 = lineScore[a], s2 = lineScore[a + 1];
      const denom = s0 - 2 * s1 + s2;
      if (Math.abs(denom) > 1e-6) refined = a + clamp(0.5 * ((s0 - s2) / denom), -1, 1);
    }
    let angle = clamp(-(refined * HOUGH_STEP - 45), -45, 45);
    if (Math.abs(angle) < 0.35) angle = 0;
    const final = lineScore[a] * (0.3 + 0.7 * extent) * Math.exp(-Math.abs(angleOf(a)) / 30);
    return { angle, extent, final, raw: lineScore[a] };
  };

  /* --- present the finalists as named techniques, best one first --- */
  const evals = peaks.map(evalPeak);
  if (!evals.length) return [];
  if ([...evals].sort((x, y) => y.final - x.final)[0].extent < 0.18) return [];
  const pickMax = (arr, f) => arr.reduce((m, c) => (f(c) > f(m) ? c : m));
  const cands = [];
  const addC = (c, tag) => {
    if (c && !cands.some((o) => Math.abs(o.angle - c.angle) < 0.3)) cands.push({ ...c, tag });
  };
  addC(pickMax(evals, (e) => e.extent), "Longest line");
  addC(pickMax(evals, (e) => e.raw), "Strongest line");
  addC(evals.reduce((m, c) => (Math.abs(c.angle) < Math.abs(m.angle) ? c : m)), "Smallest tilt");
  cands.sort((x, y) => y.final - x.final);
  // level-guard: near-zero line rivaling the winner -> the photo is straight
  const zero = cands.find((o) => o.angle === 0);
  if (zero && cands[0].angle !== 0 && zero.final >= 0.75 * cands[0].final) {
    cands.sort((x, y) => (x.angle === 0 ? -1 : y.angle === 0 ? 1 : 0));
  }
  return cands.slice(0, 3).map(({ angle, tag }) => ({ angle, tag }));
}

/* ============ browser-mode file import (fallback) ============ */
// in the desktop app TIFF/RAW/HEIC are converted by the main process;
// in a plain browser undecodable files are skipped on load automatically
const IMG_RE = /\.(jpe?g|png|webp|gif|avif|bmp|tif|tiff|heic|heif|cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|raf|dng|pef|srw|erf|kdc|3fr|mrw|x3f)$/i;
const isImageFile = (f) => (f.type && f.type.startsWith("image/")) || IMG_RE.test(f.name);

async function walkEntry(entry, parentPath, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    if (isImageFile(file)) out.push({ file, folder: parentPath });
  } else if (entry.isDirectory) {
    const childPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const e of batch) await walkEntry(e, childPath, out);
    } while (batch.length > 0);
  }
}

async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt.items ? Array.from(dt.items) : [];
  const entries = items
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    for (const e of entries) await walkEntry(e, "", out);
  } else {
    for (const f of Array.from(dt.files || []))
      if (isImageFile(f)) out.push({ file: f, folder: "" });
  }
  return out;
}

/* ============ icons ============ */
const I = {
  photos: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 15l-5-5-9 9"/></svg>,
  folder: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>,
  upload: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 16V4m0 0l-4 4m4-4l4 4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>,
  trash: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0l-1 13H7L6 7"/></svg>,
  export: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/></svg>,
  back: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M15 5l-7 7 7 7"/></svg>,
  level: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9"/><path d="M3.5 14.5l17-5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>,
  flip: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="4" y="8" width="16" height="10" rx="1.5"/><path d="M8 4h10a2 2 0 0 1 2 2" opacity=".5"/></svg>,
  rotateLeft: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M9 4 6 7l3 3"/><path d="M6 7h8a5 5 0 1 1 0 10H8"/></svg>,
  rotateRight: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M15 4l3 3-3 3"/><path d="M18 7h-8a5 5 0 1 0 0 10h6"/></svg>,
  check: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#241A03" strokeWidth="3.2"><path d="M5 13l4 4 10-10"/></svg>,
  sort: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 4v14m0 0l-3-3m3 3l3-3M17 20V6m0 0l-3 3m3-3l3 3"/></svg>,
  sun: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>,
  moon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>,
};

/* ============================================================
   RATING STARS / METADATA PANEL / FILMSTRIP
   ============================================================ */
function Stars({ value = 0, onChange, readonly }) {
  return (
    <div className={`stars ${readonly ? "readonly" : ""}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= value ? "lit" : ""}
          onClick={() => onChange && onChange(n === value ? 0 : n)}
          title={`${n}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}

function MetaPanel({ photo, outW, outH, theta, onRate, exif }) {
  const ext = (photo.name.split(".").pop() || "").toUpperCase();
  const mp = ((photo.w * photo.h) / 1e6).toFixed(1);
  const fmtShutter = (v) => (v >= 1 ? `${v}s` : `1/${Math.round(1 / v)}s`);
  const hasExif = exif && (exif.model || exif.iso || exif.exposure || exif.fnumber);
  return (
    <div className="meta">
      <h4>Rating</h4>
      <Stars value={photo.rating || 0} onChange={(v) => onRate(photo.id, v)} />
      <div className="divider" />
      <h4>File</h4>
      <div className="fname">{photo.name}</div>
      {photo.folder && (
        <div className="mrow"><span className="k">Folder</span><span className="v">{photo.folder}</span></div>
      )}
      <div className="mrow"><span className="k">Format</span><span className="v">{ext}</span></div>
      <div className="mrow"><span className="k">Dimensions</span><span className="v">{photo.w}×{photo.h}</span></div>
      <div className="mrow"><span className="k">Megapixels</span><span className="v">{mp} MP</span></div>
      {photo.sizeBytes > 0 && (
        <div className="mrow"><span className="k">Size</span><span className="v">{fmtSize(photo.sizeBytes)}</span></div>
      )}
      {photo.mtime > 0 && (
        <div className="mrow"><span className="k">Modified</span><span className="v">{new Date(photo.mtime).toLocaleDateString()}</span></div>
      )}
      {hasExif && (
        <>
          <div className="divider" />
          <h4>Camera</h4>
          {(exif.make || exif.model) && (
            <div className="mrow"><span className="k">Camera</span><span className="v">{[exif.make, exif.model].filter(Boolean).join(" ")}</span></div>
          )}
          {exif.lens && <div className="mrow"><span className="k">Lens</span><span className="v">{exif.lens}</span></div>}
          {exif.iso && <div className="mrow"><span className="k">ISO</span><span className="v">{exif.iso}</span></div>}
          {exif.exposure && <div className="mrow"><span className="k">Shutter</span><span className="v">{fmtShutter(exif.exposure)}</span></div>}
          {exif.fnumber && <div className="mrow"><span className="k">Aperture</span><span className="v">f/{exif.fnumber}</span></div>}
          {exif.focal && <div className="mrow"><span className="k">Focal</span><span className="v">{Math.round(exif.focal)} mm</span></div>}
          {exif.taken && <div className="mrow"><span className="k">Captured</span><span className="v">{new Date(exif.taken).toLocaleDateString()}</span></div>}
        </>
      )}
      <div className="divider" />
      <h4>Crop</h4>
      <div className="mrow"><span className="k">Output</span><span className="v">{outW}×{outH} px</span></div>
      {outH > 0 && (
        <div className="mrow"><span className="k">Ratio</span><span className="v">{(outW / outH).toFixed(2)}:1</span></div>
      )}
      <div className="mrow"><span className="k">Angle</span><span className="v">{theta > 0 ? "+" : ""}{theta.toFixed(1)}°</span></div>
      <div className="divider" />
      <div style={{ color: "var(--faint)", lineHeight: 1.5, fontSize: 11 }}>
        Keys 1–5 rate the photo, 0 clears.<br />Scroll on the image to zoom the whole canvas out and see the full photo, or in for precision.
      </div>
    </div>
  );
}

function Filmstrip({ items, currentId, onSelect, selectedIds, onToggleSel, onRangeSel, onContext }) {
  const ref = useRef(null);
  const anchor = useRef(null);
  useEffect(() => {
    const el = ref.current?.querySelector(".strip-item.current");
    el?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [currentId]);
  if (!items || items.length < 2) return null;
  const click = (p, idx, e) => {
    if (e.shiftKey) {
      // no anchor yet? the current photo is the natural range start
      const from = anchor.current ?? items.findIndex((x) => x.id === currentId);
      const [a, b] = [Math.min(from, idx), Math.max(from, idx)];
      onRangeSel(items.slice(Math.max(0, a), b + 1).map((x) => x.id));
      anchor.current = idx;
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      onToggleSel(p.id);
      anchor.current = idx;
      return;
    }
    anchor.current = idx;
    onSelect(p.id);
  };
  return (
    <div className="filmstrip" ref={ref}>
      {items.map((p, idx) => {
        const isSel = selectedIds?.has(p.id);
        return (
          <div
            key={p.id}
            className={`strip-item ${p.id === currentId ? "current" : ""} ${isSel ? "sel" : ""}`}
            onClick={(e) => click(p, idx, e)}
            onContextMenu={(e) => { e.preventDefault(); onContext && onContext(p.id, e.clientX, e.clientY); }}
            onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
            title={`${p.name} — Ctrl+click to select, Shift+click for a range, right-click to export`}
          >
            <Thumb src={p.previewUrl || thumbURL(p)} />
            {p.edits && <div className="sedit" />}
            {isSel && <div className="scheck">{I.check}</div>}
            <div className="sinfo">
              <span>{fmtSize(p.sizeBytes)}</span>
              {p.rating > 0 && <span className="sstars">{"★".repeat(p.rating)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   EDITOR
   ============================================================ */
const ASPECTS = [
  { key: "free", label: "Free" },
  { key: "orig", label: "Original" },
  { key: "1:1", label: "1:1", v: 1 },
  { key: "3:2", label: "3:2", v: 3 / 2 },
  { key: "4:3", label: "4:3", v: 4 / 3 },
  { key: "16:9", label: "16:9", v: 16 / 9 },
  { key: "4:5", label: "4:5", v: 4 / 5 },
];
const swapLabel = (label) => {
  const m = label.match(/^(\d+):(\d+)$/);
  return m ? `${m[2]}:${m[1]}` : label;
};
const PAD = 36;
const MIN_CROP = 64;

function Editor({ photo, siblings, onClose, onApply, onSwitch, onExport, onExportSelected, onRate, selected, onToggleSel, onRangeSel, onContextExport, suppressKeys, theme, onToggleTheme, toast }) {
  const stageRef = useRef(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [rect, setRect] = useState(null);
  const [view, setView] = useState(null); // { icx, icy, k, theta }
  const [interacting, setInteracting] = useState(false);
  const [anim, setAnim] = useState(false);
  const [aspect, setAspect] = useState("free");
  const [flipped, setFlipped] = useState(false);
  const [leveling, setLeveling] = useState(false);
  const [levelOpts, setLevelOpts] = useState(null);
  const [mode, setMode] = useState("view"); // 'view' = clean cropped photo, 'crop' = editing UI
  const [gesturing, setGesturing] = useState(false); // GPU-compositing hint during zoom/pan
  const [tile, setTile] = useState(null);            // deep-zoom sharpness overlay
  const [exif, setExif] = useState(null);
  const tileTimer = useRef(null);
  const tileUrl = useRef(null);
  const tileToken = useRef(0);
  const hist = useRef({ undo: [], redo: [] });
  const worldRef = useRef(null);
  const flipSeq = useRef(0);
  const flipBusyUntil = useRef(0);
  const [flipReq, setFlipReq] = useState(null);
  const gestTimer = useRef(null);
  const gestureOn = useCallback(() => {
    setGesturing(true);
    clearTimeout(gestTimer.current);
    gestTimer.current = setTimeout(() => setGesturing(false), 240);
  }, []);

  /* Retiring the deep-zoom tile used to be an instant setTile(null): the
     sharp tile vanished the instant a zoom-out fired, popping the view back
     to the (now hugely upscaled) blurry proxy for the first frame of the
     flip animation -- most visible on a double-click zoom-out from a tight
     zoom, where the proxy/tile quality gap is largest. Cross-fading it out
     instead hides that pop behind a quick opacity transition, and the
     motion of the flip itself masks the rest. */
  const fadeOutTile = useCallback(() => {
    clearTimeout(tileTimer.current);
    tileToken.current++;
    setTile((t) => (t && !t.fading ? { ...t, fading: true } : t));
    const url = tileUrl.current;
    tileUrl.current = null;
    if (url) {
      setTimeout(() => {
        setTile((cur) => (cur && cur.fading ? null : cur));
        URL.revokeObjectURL(url);
      }, 180);
    }
  }, []);

  /* refit()'s "FLIP" trick puts a raw, un-React-managed transform on
     .world that animates via a CSS transition running outside any render.
     Any OTHER path that jumps rect/view straight to a new value (wheel
     zoom, drag, rotate, aspect change, undo) races that transition: the
     imgspace inside recomputes its own transform for the new state
     immediately, while .world is still mid-flight from the OLD one, so the
     two compose into a bogus combined transform for a frame or more —
     visible as a jitter, or the image swinging off-screen entirely. Every
     entry point that can change rect/view outside of refit's own animation
     must cancel any in-flight flip first. */
  const cancelFlip = useCallback(() => {
    flipSeq.current++;
    flipBusyUntil.current = 0;
    const el = worldRef.current;
    if (el) {
      el.style.transition = "none";
      el.style.transform = "none";
      el.style.willChange = "auto";
    }
  }, []);

  /* --- crop history (Ctrl+Z / Ctrl+Shift+Z) --- */
  const snapshot = useCallback(() => {
    if (!rect || !view) return;
    hist.current.undo.push({ rect: { ...rect }, view: { ...view }, aspect, flipped });
    if (hist.current.undo.length > 50) hist.current.undo.shift();
    hist.current.redo = [];
  }, [rect, view, aspect, flipped]);

  const restoreSnap = useCallback((s) => {
    cancelFlip();
    zoomBase.current = s.view.k;
    setRect(s.rect);
    setView(s.view);
    setAspect(s.aspect);
    setFlipped(s.flipped);
  }, [cancelFlip]);

  const undo = useCallback(() => {
    const s = hist.current.undo.pop();
    if (!s || !rect || !view) return;
    hist.current.redo.push({ rect: { ...rect }, view: { ...view }, aspect, flipped });
    restoreSnap(s);
  }, [rect, view, aspect, flipped, restoreSnap]);

  const redo = useCallback(() => {
    const s = hist.current.redo.pop();
    if (!s || !rect || !view) return;
    hist.current.undo.push({ rect: { ...rect }, view: { ...view }, aspect, flipped });
    restoreSnap(s);
  }, [rect, view, aspect, flipped, restoreSnap]);
  const zoomBase = useRef(1);
  const drag = useRef(null);
  const refitTimer = useRef(null);
  const iw = photo.w, ih = photo.h;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const b = el.getBoundingClientRect();
      setStage({ w: b.width, h: b.height });
    });
    ro.observe(el);
    const b = el.getBoundingClientRect();
    setStage({ w: b.width, h: b.height });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!stage.w || !stage.h || rect) return;
    const availW = stage.w - 2 * PAD, availH = stage.h - 2 * PAD;
    const e = photo.edits;
    const cw = e ? e.cw : iw, ch = e ? e.ch : ih, theta = e ? e.theta : 0;
    const k = Math.min(availW / cw, availH / ch);
    const rw = cw * k, rh = ch * k;
    const r = { x: (stage.w - rw) / 2, y: (stage.h - rh) / 2, w: rw, h: rh };
    const c = { x: r.x + rw / 2, y: r.y + rh / 2 };
    let icx = c.x, icy = c.y;
    if (e) {
      const [ox, oy] = rot(k * e.qcx, k * e.qcy, rad(theta));
      icx = c.x - ox; icy = c.y - oy;
    }
    zoomBase.current = k;
    setRect(r);
    setView({ icx, icy, k, theta });
  }, [stage, rect, photo, iw, ih]);

  const coverageOK = useCallback((r, v) => {
    const t = rad(v.theta);
    const hw = (iw * v.k) / 2 + 0.5, hh = (ih * v.k) / 2 + 0.5;
    const corners = [
      [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
    ];
    for (const [cx, cy] of corners) {
      const [vx, vy] = irot(cx - v.icx, cy - v.icy, t);
      if (Math.abs(vx) > hw || Math.abs(vy) > hh) return false;
    }
    return true;
  }, [iw, ih]);

  const clampCenter = useCallback((icx, icy, r, k, thetaDeg) => {
    const t = rad(thetaDeg);
    const hw = (iw * k) / 2, hh = (ih * k) / 2;
    const corners = [
      [r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
    ];
    let minUx = Infinity, maxUx = -Infinity, minUy = Infinity, maxUy = -Infinity;
    for (const [cx, cy] of corners) {
      const [ux, uy] = irot(cx, cy, t);
      minUx = Math.min(minUx, ux); maxUx = Math.max(maxUx, ux);
      minUy = Math.min(minUy, uy); maxUy = Math.max(maxUy, uy);
    }
    let [tx, ty] = irot(icx, icy, t);
    const loX = maxUx - hw, hiX = minUx + hw;
    const loY = maxUy - hh, hiY = minUy + hh;
    tx = loX > hiX ? (loX + hiX) / 2 : clamp(tx, loX, hiX);
    ty = loY > hiY ? (loY + hiY) / 2 : clamp(ty, loY, hiY);
    const [nx, ny] = rot(tx, ty, t);
    return [nx, ny];
  }, [iw, ih]);

  const minK = useCallback((r, thetaDeg) => {
    const t = rad(thetaDeg);
    const co = Math.abs(Math.cos(t)), si = Math.abs(Math.sin(t));
    return Math.max((r.w * co + r.h * si) / iw, (r.w * si + r.h * co) / ih);
  }, [iw, ih]);

  const applyRotation = useCallback((deg) => {
    cancelFlip();
    setView((v) => {
      if (!v || !rect) return v;
      const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      const [qx, qy] = irot(c.x - v.icx, c.y - v.icy, rad(v.theta));
      const q = [qx / v.k, qy / v.k];
      const k = Math.max(zoomBase.current, minK(rect, deg) * 1.0005);
      const [ox, oy] = rot(k * q[0], k * q[1], rad(deg));
      let icx = c.x - ox, icy = c.y - oy;
      [icx, icy] = clampCenter(icx, icy, rect, k, deg);
      return { icx, icy, k, theta: deg };
    });
  }, [rect, minK, clampCenter, cancelFlip]);

  /* Re-fit uses the FLIP technique: state jumps straight to the final
     layout, and ONE GPU transform on the .world wrapper animates from the
     old geometry to identity. Zero layout work per frame, and the huge
     dim shadow is rasterized once and just composited — no more judder. */
  const refit = useCallback((r, v, animate = true) => {
    if (animate && performance.now() < flipBusyUntil.current) return;
    cancelFlip();
    const availW = stage.w - 2 * PAD, availH = stage.h - 2 * PAD;
    if (availW <= 0 || availH <= 0) return;
    const f = Math.min(availW / r.w, availH / r.h);
    const nw = r.w * f, nh = r.h * f;
    const nr = { x: (stage.w - nw) / 2, y: (stage.h - nh) / 2, w: nw, h: nh };
    const oc = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const nc = { x: nr.x + nw / 2, y: nr.y + nh / 2 };
    const nv = {
      icx: nc.x + (v.icx - oc.x) * f,
      icy: nc.y + (v.icy - oc.y) * f,
      k: v.k * f,
      theta: v.theta,
    };
    zoomBase.current = nv.k;
    if (animate && f < 1) {
      // zooming out: retire the deep-zoom tile now, in the same render as
      // the rect/view jump, so it never draws a frame with stale
      // coordinates against the new geometry — fade it rather than pop it
      // so the resolution drop isn't a jolt in itself.
      fadeOutTile();
    }
    setRect(nr);
    setView(nv);
    if (animate && Math.abs(f - 1) > 1e-4) {
      const jump = Math.max(f, 1 / f); // magnitude of the scale change, >=1
      const dur = clamp(260 + Math.log2(jump) * 55, 260, 460);
      flipBusyUntil.current = performance.now() + dur + 60;
      setFlipReq({ tx: oc.x - nc.x / f, ty: oc.y - nc.y / f, s: 1 / f, n: ++flipSeq.current, dur });
    }
  }, [stage, fadeOutTile, cancelFlip]);

  useLayoutEffect(() => {
    if (!flipReq) return;
    const el = worldRef.current;
    if (!el) return;
    const n = flipReq.n;
    el.style.transition = "none";
    el.style.willChange = "transform";
    el.style.transform = `translate(${flipReq.tx}px, ${flipReq.ty}px) scale(${flipReq.s})`;
    const dur = flipReq.dur || 340;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (flipSeq.current !== n || !worldRef.current) return;
      el.style.transition = `transform ${dur}ms cubic-bezier(.22,.85,.32,1)`;
      el.style.transform = "none";
      setTimeout(() => {
        if (flipSeq.current !== n || !worldRef.current) return;
        el.style.transition = "none";
        el.style.willChange = "auto";
      }, dur + 60);
    }));
  }, [flipReq]);

  useEffect(() => {
    if (rect && view && stage.w && stage.h) {
      const availW = stage.w - 2 * PAD, availH = stage.h - 2 * PAD;
      if (rect.w > availW || rect.h > availH || (rect.w < availW - 1 && rect.h < availH - 1)) {
        refit(rect, view, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage.w, stage.h]);

  const startDrag = (mode) => (e) => {
    if (e.button !== undefined && e.button !== 0) return; // left button only
    e.preventDefault(); e.stopPropagation();
    if (!rect || !view) return;
    cancelFlip();
    drag.current = {
      mode,
      sx: e.clientX, sy: e.clientY,
      rect: { ...rect }, view: { ...view },
    };
    if (mode !== "pan") snapshot();
    clearTimeout(refitTimer.current);
    setInteracting(true);
    setGesturing(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const aspectValue = useMemo(() => {
    const a = ASPECTS.find((x) => x.key === aspect);
    let v = null;
    if (a?.key === "orig") v = iw / ih;
    else if (a?.v) v = a.v;
    if (v && flipped && aspect !== "1:1") v = 1 / v;
    return v;
  }, [aspect, flipped, iw, ih]);

  const onMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;

    if (d.mode === "image") {
      setView((v) => {
        let icx = d.view.icx + dx, icy = d.view.icy + dy;
        [icx, icy] = clampCenter(icx, icy, d.rect, d.view.k, d.view.theta);
        return { ...v, icx, icy };
      });
      return;
    }

    if (d.mode === "pan") {
      // hand tool: move the whole workspace (frame + image together)
      setRect({ x: d.rect.x + dx, y: d.rect.y + dy, w: d.rect.w, h: d.rect.h });
      setView((v) => ({ ...v, icx: d.view.icx + dx, icy: d.view.icy + dy }));
      return;
    }

    const r0 = d.rect;
    const a = aspectValue;
    let cand = { ...r0 };
    const right = r0.x + r0.w, bottom = r0.y + r0.h;
    const cx0 = r0.x + r0.w / 2, cy0 = r0.y + r0.h / 2;
    const m = d.mode;

    const sized = (w, h) => ({ w: Math.max(MIN_CROP, w), h: Math.max(MIN_CROP, h) });

    if (m === "se" || m === "nw" || m === "ne" || m === "sw") {
      let w1 = m === "se" || m === "ne" ? r0.w + dx : r0.w - dx;
      let h1 = m === "se" || m === "sw" ? r0.h + dy : r0.h - dy;
      if (a) {
        if (w1 / a >= h1) h1 = w1 / a; else w1 = h1 * a;
      }
      const { w, h } = a ? (() => {
        let W = Math.max(w1, MIN_CROP), H = W / a;
        if (H < MIN_CROP) { H = MIN_CROP; W = H * a; }
        return { w: W, h: H };
      })() : sized(w1, h1);
      cand.w = w; cand.h = h;
      cand.x = m === "se" || m === "ne" ? r0.x : right - w;
      cand.y = m === "se" || m === "sw" ? r0.y : bottom - h;
    } else if (m === "e" || m === "w") {
      let w1 = m === "e" ? r0.w + dx : r0.w - dx;
      w1 = Math.max(MIN_CROP, w1);
      let h1 = a ? w1 / a : r0.h;
      if (a && h1 < MIN_CROP) { h1 = MIN_CROP; w1 = h1 * a; }
      cand.w = w1; cand.h = h1;
      cand.x = m === "e" ? r0.x : right - w1;
      cand.y = a ? cy0 - h1 / 2 : r0.y;
    } else if (m === "n" || m === "s") {
      let h1 = m === "s" ? r0.h + dy : r0.h - dy;
      h1 = Math.max(MIN_CROP, h1);
      let w1 = a ? h1 * a : r0.w;
      if (a && w1 < MIN_CROP) { w1 = MIN_CROP; h1 = w1 / a; }
      cand.w = w1; cand.h = h1;
      cand.y = m === "s" ? r0.y : bottom - h1;
      cand.x = a ? cx0 - w1 / 2 : r0.x;
    }

    const inStage = (r) =>
      r.x >= 6 && r.y >= 6 && r.x + r.w <= stage.w - 6 && r.y + r.h <= stage.h - 6;
    const valid = (r) => inStage(r) && coverageOK(r, d.view);
    const lerp = (t) => ({
      x: r0.x + (cand.x - r0.x) * t,
      y: r0.y + (cand.y - r0.y) * t,
      w: r0.w + (cand.w - r0.w) * t,
      h: r0.h + (cand.h - r0.h) * t,
    });
    let applied = cand;
    if (!valid(cand)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        if (valid(lerp(mid))) lo = mid; else hi = mid;
      }
      applied = lerp(lo);
    }
    setRect(applied);
  }, [aspectValue, clampCenter, coverageOK, stage]);

  const onUp = useCallback(() => {
    window.removeEventListener("pointermove", onMove);
    const wasResize = drag.current && drag.current.mode !== "image" && drag.current.mode !== "pan";
    drag.current = null;
    setInteracting(false);
    setGesturing(false);
    if (wasResize) {
      refitTimer.current = setTimeout(() => {
        setRect((r) => { setView((v) => { r && v && refit(r, v, true); return v; }); return r; });
      }, 180);
    }
  }, [onMove, refit]);

  /* --- largest rect of a given aspect that the image can cover,
         centered on the image itself (like Lightroom's aspect switch) --- */
  const maximizedRect = useCallback((v, vw) => {
    const c = { x: vw.icx, y: vw.icy };
    const rectOf = (sz) => {
      const rw = v >= 1 ? sz : sz * v;
      const rh = v >= 1 ? sz / v : sz;
      return { x: c.x - rw / 2, y: c.y - rh / 2, w: rw, h: rh };
    };
    let lo = MIN_CROP, hi = (iw + ih) * vw.k;
    if (!coverageOK(rectOf(lo), vw)) return rectOf(lo);
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (coverageOK(rectOf(mid), vw)) lo = mid; else hi = mid;
    }
    return rectOf(lo);
  }, [iw, ih, coverageOK]);

  /* --- rotate the crop frame itself by a quarter turn (portrait <-> landscape),
         e.g. for photos shot with the camera on its side. Separate from the
         fine leveling slider below: it swaps the frame's own w/h and carries
         the current fine angle straight through, so a 90 deg turn plus a
         small horizon tweak compose cleanly (baked angle = rot90 + fine,
         wrapped to -180..180). --- */
  const rotate90 = useCallback((dir = 1) => {
    if (!rect || !view) return;
    snapshot();
    cancelFlip();
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const nr = { x: cx - rect.h / 2, y: cy - rect.w / 2, w: rect.h, h: rect.w };
    let deg = view.theta + dir * 90;
    if (deg > 180) deg -= 360;
    if (deg < -180) deg += 360;
    const k = Math.max(zoomBase.current, minK(nr, deg) * 1.0005);
    let icx = cx, icy = cy;
    [icx, icy] = clampCenter(icx, icy, nr, k, deg);
    setRect(nr);
    setView({ icx, icy, k, theta: deg });
    setTimeout(() => setView((vv) => { refit(nr, vv, true); return vv; }), 20);
  }, [rect, view, snapshot, minK, clampCenter, refit, cancelFlip]);

  /* --- aspect selection: expand to the largest crop the whole image
         allows (no more progressive zoom-in), then animate the re-fit --- */
  const pickAspect = (key) => {
    snapshot();
    cancelFlip();
    setAspect(key);
    const noFlip = key === "free" || key === "orig" || key === "1:1";
    if (noFlip && flipped) setFlipped(false);
    if (!rect || !view) return;
    const def = ASPECTS.find((x) => x.key === key);
    let v = def?.key === "orig" ? iw / ih : def?.v || null;
    if (v && flipped && !noFlip) v = 1 / v;
    if (!v) return;
    const nr = maximizedRect(v, view);
    setRect(nr);
    setTimeout(() => setView((vv) => { refit(nr, vv, true); return vv; }), 20);
  };

  const toggleFlip = () => {
    if (!rect || !view || aspect === "1:1" || aspect === "free" || aspect === "orig") return;
    snapshot();
    cancelFlip();
    const nf = !flipped;
    setFlipped(nf);
    const def = ASPECTS.find((x) => x.key === aspect);
    let v = def?.key === "orig" ? iw / ih : def?.v || null;
    if (!v) {
      // free aspect: flip the current frame's own proportions
      v = rect.h / rect.w;
    } else if (nf) {
      v = 1 / v;
    }
    const nr = maximizedRect(v, view);
    setRect(nr);
    setTimeout(() => setView((vv) => { refit(nr, vv, true); return vv; }), 20);
  };

  /* --- mouse-wheel: zoom the whole canvas (frame + image together).
         Zooming out shrinks the working area so the entire photo fits
         on screen; zooming in magnifies for precision. Uniform scaling
         keeps the crop-coverage invariant, so no clamping is needed.
         Releasing a handle drag still re-fits to 100%. --- */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !rect || !view) return;
    const onWheel = (e) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const m = { x: e.clientX - b.left, y: e.clientY - b.top };
      const factor = Math.exp(-e.deltaY * 0.0024);
      const availW = stage.w - 2 * PAD, availH = stage.h - 2 * PAD;
      const kFitImg = Math.min(availW / iw, availH / ih); // whole image visible
      const kLow = Math.min(view.k, kFitImg);
      // capped well short of the old 20x: past this, a fit-to-screen
      // double-click has to animate such a large jump that the FLIP
      // transform's compositing glitches become visible.
      const kHigh = Math.max(view.k, kFitImg * 6);
      const k2 = clamp(view.k * factor, kLow, kHigh);
      const f = k2 / view.k;
      if (Math.abs(f - 1) < 1e-6) return;
      cancelFlip();
      gestureOn();
      const nr = {
        x: m.x + (rect.x - m.x) * f,
        y: m.y + (rect.y - m.y) * f,
        w: rect.w * f,
        h: rect.h * f,
      };
      zoomBase.current = k2;
      setRect(nr);
      setView({
        icx: m.x + (view.icx - m.x) * f,
        icy: m.y + (view.icy - m.y) * f,
        k: k2,
        theta: view.theta,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [rect, view, stage, iw, ih, gestureOn, cancelFlip]);

  /* --- deep-zoom sharpness: when the gesture settles and the view is
     zoomed past the proxy's resolution, fetch a tile of the visible
     region from the full-resolution original --- */
  useEffect(() => {
    if (!NATIVE || !photo.path || !view || !rect || !stage.w) return;
    const kProxy = PROXY_LONG / Math.max(iw, ih);
    if (view.k <= kProxy * 1.08 || gesturing) {
      if (view.k <= kProxy * 1.08 && tile && !tile.fading) fadeOutTile();
      return;
    }
    clearTimeout(tileTimer.current);
    const token = ++tileToken.current;
    tileTimer.current = setTimeout(async () => {
      const t = rad(view.theta);
      const corners = [[0, 0], [stage.w, 0], [0, stage.h], [stage.w, stage.h]];
      let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
      for (const [cx, cy] of corners) {
        const [ux, uy] = irot(cx - view.icx, cy - view.icy, t);
        const x = ux / view.k + iw / 2, y = uy / view.k + ih / 2;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const padX = (maxX - minX) * 0.08, padY = (maxY - minY) * 0.08;
      const sx = clamp(Math.floor(minX - padX), 0, iw - 4);
      const sy = clamp(Math.floor(minY - padY), 0, ih - 4);
      const sw = clamp(Math.ceil(maxX + padX) - sx, 4, iw - sx);
      const sh = clamp(Math.ceil(maxY + padY) - sy, 4, ih - sy);
      const dw = Math.min(4096, Math.round(sw * view.k * (window.devicePixelRatio || 1)));
      if (dw <= 8) return;
      const data = await window.meridian.renderTile(photo.path, { sx, sy, sw, sh, dw });
      if (!data || token !== tileToken.current) return;
      const url = URL.createObjectURL(new Blob([data], { type: "image/jpeg" }));
      if (tileUrl.current) URL.revokeObjectURL(tileUrl.current);
      tileUrl.current = url;
      setTile({ url, sx, sy, sw, sh });
    }, 160);
    return () => clearTimeout(tileTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, rect, gesturing, stage, iw, ih, photo.path]);

  useEffect(() => () => {
    if (tileUrl.current) URL.revokeObjectURL(tileUrl.current);
  }, []);

  const applyLevelOption = useCallback((angle) => {
    snapshot();
    setAnim(true);
    applyRotation(Math.round(angle * 10) / 10);
    setTimeout(() => setAnim(false), 360);
  }, [applyRotation, snapshot]);

  const autoLevel = async () => {
    setLeveling(true);
    try {
      const cands = await detectHorizonCandidates(photo.url);
      if (!cands.length) {
        toast("No clear horizon detected — adjust manually");
        setLevelOpts(null);
        return;
      }
      const best = cands[0];
      applyLevelOption(best.angle);
      // offer the alternatives (plus a way back to 0°) so the user decides
      const opts = [...cands];
      if (!opts.some((o) => o.angle === 0)) opts.push({ angle: 0, tag: "Original" });
      setLevelOpts(opts);
      toast(best.angle === 0
        ? "Horizon already looks level"
        : `Leveled by ${best.angle > 0 ? "+" : ""}${best.angle.toFixed(1)}° — tap an alternative if it's off`);
    } finally {
      setLeveling(false);
    }
  };

  const reset = () => {
    snapshot();
    cancelFlip();
    setAspect("free"); setFlipped(false); setLevelOpts(null);
    const availW = stage.w - 2 * PAD, availH = stage.h - 2 * PAD;
    const k = Math.min(availW / iw, availH / ih);
    const rw = iw * k, rh = ih * k;
    const r = { x: (stage.w - rw) / 2, y: (stage.h - rh) / 2, w: rw, h: rh };
    zoomBase.current = k;
    setRect(r);
    setView({ icx: stage.w / 2, icy: stage.h / 2, k, theta: 0 });
    onApply(null, null); // reverting is applied immediately
    toast("Restored to original");
  };

  const currentEdits = useCallback(() => {
    if (!rect || !view) return null;
    const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    const [qx, qy] = irot(c.x - view.icx, c.y - view.icy, rad(view.theta));
    const e = {
      theta: view.theta,
      qcx: qx / view.k,
      qcy: qy / view.k,
      cw: Math.min(iw, rect.w / view.k),
      ch: Math.min(ih, rect.h / view.k),
    };
    const isFull =
      Math.abs(e.theta) < 0.05 &&
      Math.abs(e.qcx) < 1 && Math.abs(e.qcy) < 1 &&
      e.cw > iw - 2 && e.ch > ih - 2;
    return isFull ? null : e;
  }, [rect, view, iw, ih]);

  const buildEdits = async () => {
    const e = currentEdits();
    let preview = null;
    if (e) {
      preview = await bakePreview(proxyURL(photo), iw, ih, e, 560);
    }
    return [e, preview];
  };

  /* Done / Enter: apply the crop, hide the crop UI, show the clean result */
  const apply = async () => {
    const [e, preview] = await buildEdits();
    onApply(e, preview);
    setLevelOpts(null);
    if (rect && view) refit(rect, view, true); // normalize the fitted view
    setMode("view");
    toast(e ? "Changes applied" : "Restored to original");
  };

  /* Back / Escape: apply and return to the library — nothing is lost */
  const exit = async () => {
    const [e, preview] = await buildEdits();
    onApply(e, preview);
    onClose();
  };

  /* filmstrip navigation: edits are applied automatically, Lightroom-style */
  const switchTo = async (nextId) => {
    if (nextId === photo.id) return;
    const [e, preview] = await buildEdits();
    onSwitch(e, preview, nextId);
  };

  /* EXIF for the metadata panel (cached per path) */
  useEffect(() => {
    let alive = true;
    setExif(null);
    if (NATIVE && photo.path && window.meridian.readExif) {
      if (exifCache.has(photo.path)) {
        setExif(exifCache.get(photo.path));
      } else {
        window.meridian.readExif(photo.path).then((d) => {
          exifCache.set(photo.path, d);
          if (alive) setExif(d);
        });
      }
    }
    return () => { alive = false; };
  }, [photo.path]);

  useEffect(() => {
    const onKey = (ev) => {
      if (suppressKeys) return;
      const tag = ev.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "z") {
        ev.preventDefault();
        ev.shiftKey ? redo() : undo();
        return;
      }
      if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
        if (!siblings || siblings.length < 2) return;
        ev.preventDefault();
        const idx = siblings.findIndex((s) => s.id === photo.id);
        const next = siblings[(idx + (ev.key === "ArrowRight" ? 1 : -1) + siblings.length) % siblings.length];
        if (next) switchTo(next.id);
        return;
      }
      if (ev.key === "Escape") { ev.preventDefault(); exit(); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        if (mode === "crop") apply();
        else setMode("crop");
      }
      else if (ev.key === "[" || ev.key === "]") {
        if (mode !== "crop") return;
        ev.preventDefault();
        rotate90(ev.key === "]" ? 1 : -1);
      }
      else if (/^[0-5]$/.test(ev.key)) {
        const n = parseInt(ev.key, 10);
        onRate(photo.id, n);
        toast(n ? `Rated ${"★".repeat(n)}` : "Rating cleared");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRate, photo.id, suppressKeys, toast, rect, view, mode, siblings, undo, redo]);

  const theta = view ? view.theta : 0;
  const rot90Steps = Math.round(theta / 90);
  const fineTheta = Math.round((theta - rot90Steps * 90) * 10) / 10;
  const outW = rect && view ? Math.round(Math.min(iw, rect.w / view.k)) : 0;
  const outH = rect && view ? Math.round(Math.min(ih, rect.h / view.k)) : 0;

  return (
    <div className="editor">
      <div className="topbar">
        <button className="btn ghost" onClick={exit}>{I.back} Library</button>
        <div style={{ color: "var(--muted)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {photo.name}
        </div>
        <div className="spacer" />
        <button
          className="btn ghost"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? I.sun : I.moon}
        </button>
        <button className="btn ghost" onClick={reset}>Reset</button>
        {mode === "view" ? (
          <button className="btn primary" onClick={() => setMode("crop")} title="Open crop tools (Enter)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>
            Crop
          </button>
        ) : (
          <button className="btn primary" onClick={apply} title="Apply (Enter)">Done</button>
        )}
        <button
          className="btn"
          onClick={() => (selected && selected.size > 0 ? onExportSelected() : onExport(currentEdits()))}
          title={selected && selected.size > 0 ? `Export ${selected.size} selected photos` : "Export this photo"}
        >
          {I.export} Export{selected && selected.size > 0 ? ` ${selected.size}` : ""}
        </button>
      </div>

      <div className="ed-body">
      <div
        className={`stage ${anim ? "anim" : ""}`}
        ref={stageRef}
        onPointerDown={startDrag("pan")}
        onDoubleClick={() => rect && view && refit(rect, view, true)}
        onContextMenu={(e) => {
          if (!onContextExport) return;
          e.preventDefault();
          onContextExport(photo.id, e.clientX, e.clientY);
        }}
      >
        <div className="world" ref={worldRef}>
        {view && mode === "crop" && (
          <div
            className={`imgspace ${gesturing ? "gpu" : ""}`}
            style={{
              width: iw, height: ih,
              transform: `translate(${view.icx - iw / 2}px, ${view.icy - ih / 2}px) rotate(${theta}deg) scale(${view.k})`,
            }}
          >
            <img className="base" src={proxyURL(photo)} alt="" draggable={false} />
            {tile && (
              <img
                className="tileimg"
                src={tile.url}
                alt=""
                draggable={false}
                style={{ left: tile.sx, top: tile.sy, width: tile.sw, height: tile.sh, opacity: tile.fading ? 0 : 1 }}
              />
            )}
          </div>
        )}
        {rect && view && mode === "view" && (
          <div
            className="viewclip"
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
          >
            <div
              className={`imgspace ${gesturing ? "gpu" : ""}`}
              style={{
                width: iw, height: ih,
                transform: `translate(${view.icx - rect.x - iw / 2}px, ${view.icy - rect.y - ih / 2}px) rotate(${theta}deg) scale(${view.k})`,
              }}
            >
              <img className="base" src={proxyURL(photo)} alt="" draggable={false} />
              {tile && (
                <img
                  className="tileimg"
                  src={tile.url}
                  alt=""
                  draggable={false}
                  style={{ left: tile.sx, top: tile.sy, width: tile.sw, height: tile.sh, opacity: tile.fading ? 0 : 1 }}
                />
              )}
            </div>
          </div>
        )}
        {rect && mode === "crop" && (
          <div
            className={`cropframe ${drag.current?.mode === "image" ? "grabbing" : ""}`}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onPointerDown={startDrag("image")}
          >
            <div className={`thirds ${interacting ? "on" : ""}`}>
              <div className="v" style={{ left: "33.333%" }} />
              <div className="v" style={{ left: "66.666%" }} />
              <div className="h" style={{ top: "33.333%" }} />
              <div className="h" style={{ top: "66.666%" }} />
            </div>
            <div className="handle corner h-nw" onPointerDown={startDrag("nw")} />
            <div className="handle corner h-ne" onPointerDown={startDrag("ne")} />
            <div className="handle corner h-sw" onPointerDown={startDrag("sw")} />
            <div className="handle corner h-se" onPointerDown={startDrag("se")} />
            <div className="handle edge h-n" onPointerDown={startDrag("n")} />
            <div className="handle edge h-s" onPointerDown={startDrag("s")} />
            <div className="handle edge h-e" onPointerDown={startDrag("e")} />
            <div className="handle edge h-w" onPointerDown={startDrag("w")} />
          </div>
        )}
        </div>
      </div>
      <MetaPanel photo={photo} outW={outW} outH={outH} theta={theta} onRate={onRate} exif={exif} />
      </div>

      {mode === "crop" && (
      <div className="toolbelt">
        {levelOpts && (
          <div className="level-opts">
            <span className="lo-label">Auto level options</span>
            {levelOpts.map((o, i) => {
              const active = Math.abs(theta - o.angle) < 0.15;
              return (
                <button
                  key={i}
                  className={`chip ${active ? "on" : ""}`}
                  onClick={() => applyLevelOption(o.angle)}
                >
                  {o.angle > 0 ? "+" : ""}{o.angle.toFixed(1)}° · {o.tag}
                </button>
              );
            })}
            <button className="lo-close" title="Hide options" onClick={() => setLevelOpts(null)}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        )}
        <div className="aspects">
          {ASPECTS.map((a) => (
            <button key={a.key} className={`chip ${aspect === a.key ? "on" : ""}`} onClick={() => pickAspect(a.key)}>
              {flipped && a.v && a.v !== 1 ? swapLabel(a.label) : a.label}
            </button>
          ))}
          <button
            className="chip icon"
            title="Swap portrait / landscape"
            onClick={toggleFlip}
            disabled={aspect === "1:1" || aspect === "free" || aspect === "orig"}
            style={flipped ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
          >
            {I.flip}
          </button>
          <button className="chip icon" title="Rotate 90° left" onClick={() => rotate90(-1)}>
            {I.rotateLeft}
          </button>
          <button className="chip icon" title="Rotate 90° right" onClick={() => rotate90(1)}>
            {I.rotateRight}
          </button>
        </div>
        <div className="rot-row">
          <button className="btn" onClick={autoLevel} disabled={leveling}>
            {leveling ? <span className="spin" /> : I.level} Auto level
          </button>
          <div className="rot-slider">
            <div className="notch" />
            <input
              type="range" className="rot" min={-45} max={45} step={0.1}
              value={fineTheta}
              onPointerDown={snapshot}
              onChange={(e) => applyRotation(rot90Steps * 90 + parseFloat(e.target.value))}
              onDoubleClick={() => { snapshot(); applyRotation(rot90Steps * 90); }}
            />
          </div>
          <div className={`degree ${Math.abs(fineTheta) < 0.05 ? "zero" : ""}`}>
            {fineTheta > 0 ? "+" : ""}{fineTheta.toFixed(1)}°
          </div>
        </div>
      </div>
      )}

      <Filmstrip
        items={siblings}
        currentId={photo.id}
        onSelect={switchTo}
        selectedIds={selected}
        onToggleSel={onToggleSel}
        onRangeSel={onRangeSel}
        onContext={onContextExport}
      />
    </div>
  );
}

/* ============================================================
   EXPORT DIALOG
   ============================================================ */
function ExportDialog({ items, onClose, onSavePreset, presets, onRunPreset, toast }) {
  const [format, setFormat] = useState("jpeg");
  const [targetMB, setTargetMB] = useState("2");
  const [scale, setScale] = useState(100);
  const [estimate, setEstimate] = useState(null);
  const [calculating, setCalculating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [presetName, setPresetName] = useState("");
  const [template, setTemplate] = useState("{name}");
  const [keepExif, setKeepExif] = useState(false);
  const veilDownOnSelf = useRef(false);
  const closeOnVeil = useCallback((e) => {
    if (e.target === e.currentTarget && veilDownOnSelf.current && !exporting) onClose();
    veilDownOnSelf.current = false;
  }, [exporting, onClose]);
  const canvasCache = useRef({}); // scale -> canvas (browser fallback)
  const solverCache = useRef({}); // `${scale}|${mime}` -> solve() (browser fallback)
  const single = items.length === 1;
  const mime = format === "jpeg" ? "image/jpeg" : "image/webp";
  const targetBytes = Math.max(0.05, parseFloat(targetMB) || 0.05) * 1024 * 1024;
  const targetMBn = Math.max(0.05, parseFloat(targetMB) || 0.05);

  const getSolver = useCallback(async (item, sc, mm) => {
    const cKey = `${sc}`;
    let canvas = canvasCache.current[cKey];
    if (!canvas) {
      canvas = await bakeCanvas(item.photo, item.edits, sc);
      canvasCache.current[cKey] = canvas;
    }
    const sKey = `${sc}|${mm}`;
    if (!solverCache.current[sKey]) {
      solverCache.current[sKey] = { solve: makeSizeSolver(canvas, mm), canvas };
    }
    return solverCache.current[sKey];
  }, []);

  useEffect(() => {
    if (!single) return;
    let alive = true;
    setCalculating(true);
    const delay = estimate ? 400 : 0; // no delay on first open — nothing to show yet
    const t = setTimeout(async () => {
      try {
        if (NATIVE && items[0].photo.path) {
          const res = await window.meridian.estimatePhoto(
            { path: items[0].photo.path, name: items[0].photo.name, edits: items[0].edits },
            { format, targetMB: targetMBn, scale, keepExif }
          );
          if (alive) {
            setEstimate(res && !res.error
              ? { size: res.size, quality: res.quality / 100, over: res.over, maxed: res.maxed, w: res.w, h: res.h }
              : null);
            setCalculating(false);
          }
        } else {
          const { solve, canvas } = await getSolver(items[0], scale, mime);
          const res = await solve(targetBytes);
          if (alive) {
            setEstimate(res ? { size: res.blob.size, blob: res.blob, quality: res.quality, over: res.over, w: canvas.width, h: canvas.height } : null);
            setCalculating(false);
          }
        }
      } catch {
        if (alive) { setEstimate(null); setCalculating(false); }
      }
    }, delay);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, items, mime, format, targetBytes, targetMBn, scale, keepExif, getSolver]);

  const browserDownload = (blob, name) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const doExport = async () => {
    setExporting(true);
    try {
      if (NATIVE && items.every((it) => it.photo.path)) {
        setProgress("Exporting…");
        const serial = items.map((it) => ({ path: it.photo.path, name: it.photo.name, edits: it.edits }));
        const res = await window.meridian.exportPhotos(serial, {
          format, targetMB: targetMBn, scale, dir: null, template, keepExif,
        });
        if (res.canceled) { setExporting(false); setProgress(null); return; }
        toast(items.length > 1
          ? `Exported ${res.exported}${res.failed ? `, ${res.failed} failed` : ""}`
          : "Photo exported");
        onClose();
        return;
      }

      /* browser fallback: canvas pipeline + downloads */
      const ext = format === "jpeg" ? "jpg" : "webp";
      const prepared = [];
      if (single && estimate && estimate.blob && !calculating) {
        const { photo, edits } = items[0];
        const base = photo.name.replace(/\.[^.]+$/, "");
        prepared.push({ name: `${base}${edits ? "-edited" : ""}.${ext}`, blob: estimate.blob });
      } else {
        for (let i = 0; i < items.length; i++) {
          setProgress(items.length > 1 ? `Compressing ${i + 1} / ${items.length}…` : "Compressing…");
          const { photo, edits } = items[i];
          const canvas = await bakeCanvas(photo, edits, scale);
          const solve = makeSizeSolver(canvas, mime);
          const res = await solve(targetBytes);
          if (!res) continue;
          const base = photo.name.replace(/\.[^.]+$/, "");
          prepared.push({ name: `${base}${edits ? "-edited" : ""}.${ext}`, blob: res.blob });
        }
      }
      for (const p of prepared) {
        browserDownload(p.blob, p.name);
        if (prepared.length > 1) await new Promise((r) => setTimeout(r, 350));
      }
      toast(prepared.length > 1 ? `Exported ${prepared.length} photos` : "Photo exported");
      onClose();
    } finally {
      setExporting(false);
      setProgress(null);
    }
  };

  return (
    <div
      className="veil"
      onPointerDown={(e) => { veilDownOnSelf.current = e.target === e.currentTarget; }}
      onPointerUp={closeOnVeil}
    >
      <div className="dialog">
        <h3>Export</h3>
        <div className="sub">{single ? items[0].photo.name : `${items.length} photos selected`}</div>

        {presets && presets.length > 0 && (
          <div className="field">
            <label>Presets — one click exports straight to their folder</label>
            <div className="preset-list">
              {presets.map((pr) => (
                <button key={pr.id} className="preset-row" disabled={exporting} onClick={() => onRunPreset(pr)}>
                  <span className="cm-name">{pr.name}</span>
                  <span className="cm-sub">≤{pr.targetMB} MB · {pr.format.toUpperCase()} · {pr.scale}% → {baseName(pr.dir)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <label>Format</label>
          <div className="controls">
            <div className="seg">
              <button className={format === "jpeg" ? "on" : ""} onClick={() => setFormat("jpeg")}>JPEG</button>
              <button className={format === "webp" ? "on" : ""} onClick={() => setFormat("webp")}>WebP</button>
            </div>
          </div>
        </div>

        <div className="field">
          <label>Max file size</label>
          <div className="controls">
            <div className="numinput">
              <input
                type="number" min="0.1" step="0.1" value={targetMB}
                onChange={(e) => setTargetMB(e.target.value)}
              />
              <span className="unit">MB{single ? "" : " each"}</span>
            </div>
          </div>
        </div>

        <div className="field">
          <label>Resolution</label>
          <div className="controls">
            <div className="seg">
              {[100, 75, 50, 25].map((p) => (
                <button key={p} className={scale === p ? "on" : ""} onClick={() => setScale(p)}>{p}%</button>
              ))}
            </div>
          </div>
        </div>

        {NATIVE && (
          <div className="field">
            <label className="chk" title="Adds camera, lens and date to the file">
              <input type="checkbox" checked={keepExif} onChange={(e) => setKeepExif(e.target.checked)} />
              Keep EXIF
            </label>
          </div>
        )}

        {single && (
          <div className={`estimate ${estimate && estimate.over && !calculating ? "warn" : ""}`}>
            {calculating && <span className="spin" />}
            {estimate ? (
              <span style={calculating ? { opacity: 0.55 } : undefined}>
                {estimate.over ? (
                  <>Smallest possible at this resolution is <strong>{fmtMB(estimate.size)}</strong> — lower the resolution to hit the target.</>
                ) : estimate.maxed ? (
                  <>Maximum quality reached: <strong>{fmtMB(estimate.size)}</strong> · quality 100 · {estimate.w}×{estimate.h}px — already under your limit, extra bytes wouldn't add detail.</>
                ) : (
                  <>Estimated file: <strong>{fmtMB(estimate.size)}</strong> · quality {Math.round(estimate.quality * 100)} · {estimate.w}×{estimate.h}px{NATIVE ? " · MozJPEG" : ""}</>
                )}
              </span>
            ) : calculating ? (
              <span>Calculating size…</span>
            ) : (
              <span>Estimate unavailable</span>
            )}
          </div>
        )}
        {!single && (
          <div className="estimate">
            <span>Each photo will be compressed to stay under <strong>{parseFloat(targetMB) || 0} MB</strong>{NATIVE ? " (MozJPEG / WebP)" : ""}.</span>
          </div>
        )}

        {onSavePreset && (
          <div className="field">
            <label title="Remembers folder, format and size">Save as preset</label>
            <div className="controls">
              <div className="numinput" style={{ flex: 1 }}>
                <input
                  type="text"
                  placeholder="Preset name"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  style={{ fontFamily: "var(--sans)" }}
                />
              </div>
              <button
                className="btn"
                disabled={!presetName.trim() || exporting}
                title="Pick a folder and save"
                onClick={async () => {
                  const ok = await onSavePreset({
                    name: presetName.trim(), format, targetMB: targetMBn, scale, template, keepExif,
                  });
                  if (ok) setPresetName("");
                }}
              >
                Save…
              </button>
            </div>
          </div>
        )}

        <div className="actions">
          <button className="btn ghost" onClick={onClose} disabled={exporting}>Cancel</button>
          <button className="btn primary" onClick={doExport} disabled={exporting}>
            {exporting ? (progress || "Exporting…") : `Export${single ? "" : ` ${items.length}`}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* context menu that never falls off-screen and never "jumps":
   it is remounted per position (key), measured synchronously before
   the first paint, and only then made visible */
function CtxMenuInner({ x, y, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y, visibility: "hidden" });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x, top = y;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height);
    setPos({ left, top, visibility: "visible" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="ctxmenu" ref={ref} style={pos} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
function CtxMenu(props) {
  return <CtxMenuInner key={`${props.x}:${props.y}`} {...props} />;
}

/* image that fades in over the skeleton shimmer; no flash for cached files */
function Thumb({ src, alt }) {
  const r = useRef(null);
  useLayoutEffect(() => {
    if (r.current?.complete) r.current.style.opacity = 1;
  });
  return (
    <img
      ref={r}
      src={src}
      alt={alt || ""}
      loading="lazy"
      draggable={false}
      style={{ opacity: 0, transition: "opacity .18s" }}
      onLoad={(e) => { e.currentTarget.style.opacity = 1; }}
    />
  );
}

/* ============================================================
   APP
   ============================================================ */
export default function App() {
  const [photos, setPhotos] = useState([]);
  const [libLoaded, setLibLoaded] = useState(!NATIVE);
  const [selected, setSelected] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [activeFolder, setActiveFolder] = useState("__all__");
  const [thumb, setThumb] = useState(164);
  const [sortDesc, setSortDesc] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [exportItems, setExportItems] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [watchedRoots, setWatchedRoots] = useState([]);
  const [theme, setTheme] = useState("dark");
  const [presets, setPresets] = useState([]);      // export presets {id,name,format,targetMB,scale,dir}
  const [ctxMenu, setCtxMenu] = useState(null);    // {x, y, ids}
  const [minRating, setMinRating] = useState(0);   // sidebar rating filter
  const [busyExport, setBusyExport] = useState(null);
  const fileInput = useRef(null);
  const folderInput = useRef(null);
  const dragCount = useRef(0);
  const toastTimer = useRef(null);
  const loadedOnce = useRef(false);
  const photosRef = useRef([]);
  useEffect(() => { photosRef.current = photos; }, [photos]);

  const toast = useCallback((msg, action = null, ttl = 2600) => {
    setToastMsg(msg ? { text: msg, action } : null);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), action ? Math.max(ttl, 6000) : ttl);
  }, []);

  const undoRemoval = useCallback(async (removedPhotos, roots) => {
    setPhotos((prev) => {
      const have = new Set(prev.map((p) => p.id));
      return [...prev, ...removedPhotos.filter((p) => !have.has(p.id))];
    });
    if (NATIVE && roots.length) {
      const updated = await window.meridian.watchRoots(roots);
      setWatchedRoots(updated);
    }
    toast("Restored");
  }, [toast]);


  /* ---- persistent library (native) ---- */
  useEffect(() => {
    if (!NATIVE || loadedOnce.current) return;
    loadedOnce.current = true;
    (async () => {
      const { items, missing, watchedRoots: roots, settings } = await window.meridian.loadLibrary();
      setPhotos(items.map((rec) => ({
        ...rec,
        sizeBytes: rec.sizeBytes ?? rec.size ?? 0,
        mtime: rec.mtime ?? 0,
        rating: rec.rating ?? 0,
        url: photoURL(rec.path),
      })));
      if (settings?.theme === "light") setTheme("light");
      if (Array.isArray(settings?.exportPresets)) setPresets(settings.exportPresets);
      setWatchedRoots(roots || []);
      setLibLoaded(true);
      if (missing > 0) toast(`${missing} photo${missing > 1 ? "s" : ""} removed — files no longer on disk`);
    })();
  }, [toast]);

  /* ---- helper: records [{path,name,folder}] -> photo objects with dims ---- */
  const loadRecords = useCallback(async (records) => {
    const base = Date.now();
    const loaded = [];
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const url = photoURL(r.path);
      try {
        const img = await loadImage(url);
        loaded.push({
          id: uid(), path: r.path, name: r.name, folder: r.folder || "",
          url, w: img.naturalWidth, h: img.naturalHeight,
          sizeBytes: r.size || 0, mtime: r.mtime || 0, rating: 0,
          addedAt: base + i, edits: null, previewUrl: null,
        });
      } catch {
        imgCache.delete(url);
      }
    }
    return loaded;
  }, []);

  /* ---- live folder sync: watched folders push changes from disk ---- */
  useEffect(() => {
    if (!NATIVE) return;
    const off = window.meridian.onFolderScan(async ({ root, records }) => {
      const present = new Set(records.map((r) => r.path));
      const currentPaths = new Set(photosRef.current.map((p) => p.path));
      const fresh = records.filter((r) => !currentPaths.has(r.path));
      const loaded = await loadRecords(fresh);

      let removed = 0;
      const recByPath = new Map(records.map((r) => [r.path, r]));
      setPhotos((prev) => {
        const kept = prev
          .filter((p) => !p.path || !isUnder(p.path, root) || present.has(p.path))
          .map((p) => {
            const r = p.path && recByPath.get(p.path);
            if (r && (r.size !== p.sizeBytes || r.mtime !== p.mtime)) {
              return { ...p, sizeBytes: r.size, mtime: r.mtime };
            }
            return p;
          });
        removed = prev.length - kept.length;
        const keptPaths = new Set(kept.map((p) => p.path));
        const add = loaded.filter((p) => !keptPaths.has(p.path));
        return add.length ? [...kept, ...add] : kept;
      });

      if (loaded.length || removed) {
        const parts = [];
        if (loaded.length) parts.push(`+${loaded.length}`);
        if (removed) parts.push(`−${removed}`);
        toast(`"${baseName(root)}" synced (${parts.join(", ")})`);
      }
    });
    return off;
  }, [loadRecords, toast]);

  useEffect(() => {
    if (!NATIVE || !libLoaded) return;
    const t = setTimeout(() => {
      const serializable = photos.map(({ url, ...rest }) => rest);
      window.meridian.saveLibrary(serializable, { theme, exportPresets: presets });
    }, 400);
    return () => clearTimeout(t);
  }, [photos, libLoaded, theme, presets]);

  /* ---- import: native records [{path, name, folder}] ---- */
  const addNativeRecords = useCallback(async (records) => {
    if (!records || !records.length) { toast("No supported images found"); return; }
    const existing = new Set(photosRef.current.map((p) => p.path));
    const fresh = records.filter((r) => !existing.has(r.path));
    if (!fresh.length) { toast("These photos are already in the library"); return; }
    const loaded = await loadRecords(fresh);
    if (!loaded.length) { toast("Couldn't decode those files"); return; }
    setPhotos((prev) => [...prev, ...loaded]);
    toast(`Imported ${loaded.length} photo${loaded.length > 1 ? "s" : ""}`);
  }, [loadRecords, toast]);

  /* ---- import: browser fallback [{file, folder}] ---- */
  const addBrowserFiles = useCallback(async (entries) => {
    if (!entries.length) { toast("No supported images found"); return; }
    const base = Date.now();
    const loaded = [];
    for (let i = 0; i < entries.length; i++) {
      const { file, folder } = entries[i];
      const url = URL.createObjectURL(file);
      try {
        const img = await loadImage(url);
        loaded.push({
          id: uid(), name: file.name, folder: folder || "",
          url, w: img.naturalWidth, h: img.naturalHeight,
          sizeBytes: file.size || 0, mtime: file.lastModified || 0, rating: 0,
          addedAt: base + i, edits: null, previewUrl: null,
        });
      } catch {
        URL.revokeObjectURL(url);
        imgCache.delete(url);
      }
    }
    if (!loaded.length) { toast("Couldn't decode those files"); return; }
    setPhotos((prev) => [...prev, ...loaded]);
    toast(`Imported ${loaded.length} photo${loaded.length > 1 ? "s" : ""}`);
  }, [toast]);

  const importPhotos = async () => {
    if (NATIVE) addNativeRecords(await window.meridian.pickFiles());
    else fileInput.current?.click();
  };
  const importFolder = async () => {
    if (NATIVE) {
      const { root, records } = await window.meridian.pickFolder();
      if (!root) return;
      setWatchedRoots((prev) => (prev.includes(root) ? prev : [...prev, root]));
      await addNativeRecords(records);
    } else {
      folderInput.current?.click();
    }
  };

  const onPickFiles = (e) => {
    const list = Array.from(e.target.files || [])
      .filter(isImageFile)
      .map((file) => {
        const rel = file.webkitRelativePath || "";
        const folder = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : "";
        return { file, folder };
      });
    addBrowserFiles(list);
    e.target.value = "";
  };

  const onDrop = async (e) => {
    e.preventDefault();
    dragCount.current = 0;
    setDragOver(false);
    if (NATIVE) {
      const paths = Array.from(e.dataTransfer.files || [])
        .map((f) => {
          try { return window.meridian.getPathForFile(f); } catch { return null; }
        })
        .filter(Boolean);
      const { records, roots } = await window.meridian.importPaths(paths);
      if (roots?.length) {
        setWatchedRoots((prev) => [...prev, ...roots.filter((r) => !prev.includes(r))]);
      }
      addNativeRecords(records);
    } else {
      const entries = await filesFromDataTransfer(e.dataTransfer);
      addBrowserFiles(entries);
    }
  };

  /* ---- library derived state: hierarchical folder tree ---- */
  const folderTree = useMemo(() => {
    const counts = new Map(); // label -> photos in the whole subtree
    const labels = new Set();
    for (const p of photos) {
      if (!p.folder) continue;
      const parts = p.folder.split("/");
      let acc = "";
      for (let i = 0; i < parts.length; i++) {
        acc = i ? `${acc}/${parts[i]}` : parts[i];
        labels.add(acc);
        counts.set(acc, (counts.get(acc) || 0) + 1);
      }
    }
    return [...labels].sort((a, b) => a.localeCompare(b)).map((label) => ({
      label,
      depth: label.split("/").length - 1,
      name: label.split("/").pop(),
      count: counts.get(label) || 0,
    }));
  }, [photos]);

  const visible = useMemo(() => {
    let list = photos;
    if (activeFolder === "__edited__") list = list.filter((p) => p.edits);
    else if (activeFolder !== "__all__") {
      // a folder node shows its whole subtree
      list = list.filter(
        (p) => p.folder === activeFolder || (p.folder && p.folder.startsWith(activeFolder + "/"))
      );
    }
    if (minRating > 0) list = list.filter((p) => (p.rating || 0) >= minRating);
    return [...list].sort((a, b) => (sortDesc ? b.addedAt - a.addedAt : a.addedAt - b.addedAt));
  }, [photos, activeFolder, sortDesc, minRating]);

  useEffect(() => {
    if (activeFolder !== "__all__" && activeFolder !== "__edited__" &&
        !folderTree.some((n) => n.label === activeFolder)) {
      setActiveFolder("__all__");
    }
  }, [folderTree, activeFolder]);

  /* ---- selection / delete ---- */
  const toggleSelect = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  const clearSelection = () => { setSelected(new Set()); setSelectMode(false); };

  const deleteSelected = () => {
    const deleted = photosRef.current.filter((p) => selected.has(p.id));
    let affected = [];
    if (NATIVE) {
      // a watched folder would re-add these photos on the next scan,
      // so removing its photos also stops syncing that folder
      affected = watchedRoots.filter((root) => deleted.some((p) => isUnder(p.path, root)));
      if (affected.length) {
        for (const root of affected) window.meridian.unwatchRoot(root);
        setWatchedRoots((prev) => prev.filter((r) => !affected.includes(r)));
      }
      setPhotos((prev) => prev.filter((p) => !selected.has(p.id)));
    } else {
      setPhotos((prev) => prev.filter((p) => !selected.has(p.id)));
    }
    toast(
      `Removed ${deleted.length} from library${NATIVE ? " (files stay on disk)" : ""}`,
      { label: "Undo", fn: () => undoRemoval(deleted, affected) }
    );
    clearSelection();
  };

  /* ---- migrate: folders imported before watching existed start syncing
         automatically, without re-adding them ---- */
  const migrated = useRef(false);
  useEffect(() => {
    if (!NATIVE || !libLoaded || migrated.current) return;
    migrated.current = true;
    (async () => {
      const have = new Set(watchedRoots.map((r) => r.replace(/\\/g, "/")));
      const roots = new Set();
      for (const p of photosRef.current) {
        const r = deriveRoot(p);
        if (r && !have.has(r)) roots.add(r);
      }
      if (roots.size) {
        const updated = await window.meridian.watchRoots([...roots]);
        setWatchedRoots(updated);
      }
    })();
  }, [libLoaded, watchedRoots]);

  /* ---- per-folder sync toggle (sidebar) ---- */
  const rootForGroup = useCallback((group) =>
    watchedRoots.find((r) => baseName(r) === group) || null,
  [watchedRoots]);

  /* ---- remove a whole folder from the library ---- */
  const removeFolder = useCallback(async (folderLabel) => {
    const group = folderLabel.split("/")[0];
    const inFolder = (p) =>
      p.folder === folderLabel || (p.folder && p.folder.startsWith(folderLabel + "/"));
    const targets = photosRef.current.filter(inFolder);
    if (!targets.length) return;
    const unwatched = [];
    if (NATIVE) {
      const watched = rootForGroup(group);
      if (watched) {
        await window.meridian.unwatchRoot(watched);
        setWatchedRoots((prev) => prev.filter((r) => r !== watched));
        unwatched.push(watched);
      }
    }
    setPhotos((prev) => prev.filter((p) => !inFolder(p)));
    toast(
      `Removed "${folderLabel.split("/").pop()}" (${targets.length} photo${targets.length > 1 ? "s" : ""})${NATIVE ? " — files stay on disk" : ""}`,
      { label: "Undo", fn: () => undoRemoval(targets, unwatched) }
    );
  }, [rootForGroup, toast, undoRemoval]);

  /* ---- batch auto-level for the selection ---- */
  const batchLevel = useCallback(async () => {
    const ids = [...selected];
    clearSelection();
    let done = 0, fixed = 0;
    for (const id of ids) {
      const p = photosRef.current.find((x) => x.id === id);
      done++;
      setBusyExport(`Auto level ${done} / ${ids.length}…`);
      if (!p) continue;
      try {
        const src = proxyURL(p);
        const cands = await detectHorizonCandidates(src);
        const a = cands[0]?.angle || 0;
        if (!a) continue;
        // largest full-aspect crop that the rotated frame can cover
        const t = rad(Math.abs(a));
        const f = Math.max(
          Math.cos(t) + (p.h / p.w) * Math.sin(t),
          (p.w / p.h) * Math.sin(t) + Math.cos(t)
        );
        const edits = { theta: a, qcx: 0, qcy: 0, cw: p.w / f, ch: p.h / f };
        const preview = await bakePreview(src, p.w, p.h, edits, 560);
        setPhotos((prev) => prev.map((x) => (x.id === id ? { ...x, edits, previewUrl: preview } : x)));
        fixed++;
      } catch {}
    }
    setBusyExport(null);
    toast(`Leveled ${fixed} of ${ids.length} photo${ids.length > 1 ? "s" : ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, toast]);

  /* ---- ratings ---- */
  const setRating = useCallback((id, rating) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, rating } : p)));
  }, []);

  /* ---- export presets & context menu ---- */
  useEffect(() => {
    if (!NATIVE || !window.meridian.onExportProgress) return;
    const off = window.meridian.onExportProgress(({ done, total, name }) => {
      if (done < total) setBusyExport(`Exporting ${done + 1} / ${total}${name ? ` — ${name}` : ""}…`);
      else setBusyExport(null);
    });
    return off;
  }, []);

  const openContextMenu = useCallback((photoId, x, y) => {
    const ids = selected.has(photoId) && selected.size > 0 ? [...selected] : [photoId];
    setCtxMenu({ x, y, type: "export", ids });
  }, [selected]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("keydown", onKey); };
  }, [ctxMenu]);

  const serializeItems = useCallback((ids) =>
    photosRef.current
      .filter((p) => ids.includes(p.id) && p.path)
      .map((p) => ({ path: p.path, name: p.name, edits: p.edits })),
  []);

  const runPreset = useCallback(async (preset, ids) => {
    setCtxMenu(null);
    const items = serializeItems(ids);
    if (!items.length) return;
    setBusyExport(`Exporting ${items.length}…`);
    try {
      const res = await window.meridian.exportPhotos(items, {
        format: preset.format, targetMB: preset.targetMB, scale: preset.scale, dir: preset.dir,
        template: preset.template || "{name}", keepExif: !!preset.keepExif,
      });
      if (res.ok) {
        toast(`"${preset.name}": exported ${res.exported}${res.failed ? `, ${res.failed} failed` : ""} → ${baseName(res.dir)}`);
      }
    } finally {
      setBusyExport(null);
    }
  }, [serializeItems, toast]);

  const savePreset = useCallback(async (draft) => {
    const dir = await window.meridian.pickDir();
    if (!dir) return false;
    setPresets((prev) => [...prev, { ...draft, dir, id: uid() }]);
    toast(`Preset "${draft.name}" saved → ${baseName(dir)}`);
    return true;
  }, [toast]);

  const deletePreset = useCallback((id) => {
    setPresets((prev) => prev.filter((p) => p.id !== id));
  }, []);

  /* ---- editor plumbing ---- */
  const editingPhoto = photos.find((p) => p.id === editingId) || null;

  const editorSiblings = useMemo(() => {
    if (!editingPhoto) return [];
    return photos
      .filter((p) => p.folder === editingPhoto.folder)
      .sort((a, b) => (sortDesc ? b.addedAt - a.addedAt : a.addedAt - b.addedAt));
  }, [photos, editingPhoto, sortDesc]);

  const applyEdits = (edits, previewUrl) => {
    setPhotos((prev) => prev.map((p) => (p.id === editingId ? { ...p, edits, previewUrl } : p)));
  };

  const switchEditing = (edits, previewUrl, nextId) => {
    setPhotos((prev) => prev.map((p) => (p.id === editingId ? { ...p, edits, previewUrl } : p)));
    setEditingId(nextId);
  };

  const openExportFromEditor = (liveEdits) => {
    if (!editingPhoto) return;
    setExportItems([{ photo: editingPhoto, edits: liveEdits }]);
  };

  const exportSelected = () => {
    const items = photos.filter((p) => selected.has(p.id)).map((p) => ({ photo: p, edits: p.edits }));
    if (items.length) setExportItems(items);
  };

  const anchorIdx = useRef(null);

  /* ---- virtualized grid: only visible cells are rendered ---- */
  const gridRef = useRef(null);
  const [gridScroll, setGridScroll] = useState(0);
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  const scrollRaf = useRef(false);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setGridSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setGridSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [photos.length > 0]);
  const onGridScroll = () => {
    if (scrollRaf.current) return;
    scrollRaf.current = true;
    requestAnimationFrame(() => {
      scrollRaf.current = false;
      if (gridRef.current) setGridScroll(gridRef.current.scrollTop);
    });
  };
  const GAP = 6, PADG = 18;
  const cols = Math.max(1, Math.floor((gridSize.w - PADG * 2 + GAP) / (thumb + GAP)));
  const cellW = cols > 0 ? (gridSize.w - PADG * 2 - GAP * (cols - 1)) / cols : thumb;
  const rowH = cellW + GAP;
  const totalRows = Math.ceil(visible.length / cols);
  const totalH = Math.max(0, totalRows * rowH - GAP) + PADG * 2;
  const startRow = Math.max(0, Math.floor((gridScroll - PADG) / rowH) - 2);
  const endRow = Math.min(totalRows, Math.ceil((gridScroll + gridSize.h - PADG) / rowH) + 2);
  const winStart = startRow * cols;
  const winEnd = Math.min(visible.length, endRow * cols);

  const rangeSelect = useCallback((ids) => {
    setSelected((s) => new Set([...s, ...ids]));
  }, []);

  const cellClick = (p, idx, e) => {
    if (e.shiftKey && anchorIdx.current !== null) {
      const [a, b] = [Math.min(anchorIdx.current, idx), Math.max(anchorIdx.current, idx)];
      rangeSelect(visible.slice(a, b + 1).map((x) => x.id));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(p.id);
      anchorIdx.current = idx;
      return;
    }
    if (selectMode || selected.size > 0) {
      toggleSelect(p.id);
      anchorIdx.current = idx;
    } else {
      setEditingId(p.id);
    }
  };

  return (
    <div
      className={`app ${theme === "light" ? "light" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setDragOver(true); }}
      onDragLeave={() => { dragCount.current--; if (dragCount.current <= 0) { dragCount.current = 0; setDragOver(false); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <style>{CSS}</style>

      <div className="topbar">
        <div className="brand"><span className="dot" /><span className="name">MERIDIAN</span></div>
        <button className="btn" onClick={importPhotos}>{I.upload} Import photos</button>
        <button className="btn" onClick={importFolder}>{I.folder} Import folder</button>
        {!NATIVE && (
          <>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={onPickFiles} />
          </>
        )}
        <div className="spacer" />
        <button
          className="btn ghost"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? I.sun : I.moon}
        </button>
        {photos.length > 0 && (
          <>
            <button className="btn ghost" title="Sort by date added" onClick={() => setSortDesc((s) => !s)}>
              {I.sort} {sortDesc ? "Newest" : "Oldest"}
            </button>
            <div className="thumbslider">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              <input
                type="range" className="rot" style={{ width: 110 }}
                min={96} max={280} value={thumb}
                onChange={(e) => setThumb(+e.target.value)}
              />
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
            </div>
            {selected.size > 0 ? (
              <>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{selected.size} selected</span>
                <button className="btn" onClick={batchLevel} title="Auto-level all selected photos">{I.level} Level</button>
                <button className="btn" onClick={exportSelected}>{I.export} Export</button>
                <button className="btn danger" onClick={deleteSelected}>{I.trash} Remove</button>
                <button className="btn ghost" onClick={clearSelection}>Cancel</button>
              </>
            ) : (
              <button className={`btn ${selectMode ? "active" : ""}`} onClick={() => setSelectMode((s) => !s)}>
                Select
              </button>
            )}
          </>
        )}
      </div>

      <div className="body">
        <div className="sidebar">
          <button className={`side-item ${activeFolder === "__all__" ? "active" : ""}`} onClick={() => setActiveFolder("__all__")}>
            {I.photos} All Photos <span className="count">{photos.length}</span>
          </button>
          <button className={`side-item ${activeFolder === "__edited__" ? "active" : ""}`} onClick={() => setActiveFolder("__edited__")}>
            {I.level} Edited <span className="count">{photos.filter((p) => p.edits).length}</span>
          </button>
          <div className="side-label">Rating</div>
          <div className="side-rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={n <= minRating ? "lit" : ""}
                title={`Show ★${n} and up`}
                onClick={() => setMinRating((m) => (m === n ? 0 : n))}
              >
                ★
              </button>
            ))}
            {minRating > 0 && (
              <button className="clear" onClick={() => setMinRating(0)} title="Clear filter">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
          {folderTree.length > 0 && <div className="side-label">Folders</div>}
          {folderTree.map((node) => {
            const { label: f, depth, name, count } = node;
            const isRoot = depth === 0;
            return (
              <button
                key={f}
                className={`side-item ${activeFolder === f ? "active" : ""}`}
                style={{ paddingLeft: 10 + depth * 16 }}
                onClick={() => setActiveFolder(f)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, type: "folder", label: f, name });
                }}
                title={`${f} · right-click to remove`}
              >
                {isRoot ? I.folder : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ opacity: .6 }}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                <span className="count">{count}</span>
              </button>
            );
          })}
        </div>

        <div className="main">
          {photos.length === 0 ? (
            <div className="empty">
              <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="1.4"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 15l-5-5-9 9"/></svg>
              <h2>{libLoaded ? "Your library is empty" : "Loading library…"}</h2>
              {libLoaded && (
                <>
                  <p>Drop photos or folders anywhere in this window, or use the import buttons. Originals on disk are never modified — every edit can be reverted.</p>
                  <div className="row">
                    <button className="btn primary" onClick={importPhotos}>{I.upload} Import photos</button>
                    <button className="btn" onClick={importFolder}>{I.folder} Import folder</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="gridwrap" ref={gridRef} onScroll={onGridScroll} style={{ padding: 0 }}>
              <div style={{ position: "relative", height: totalH }}>
                {visible.slice(winStart, winEnd).map((p, i) => {
                  const idx = winStart + i;
                  const row = Math.floor(idx / cols), col = idx % cols;
                  const cellStyle = {
                    position: "absolute",
                    left: PADG + col * (cellW + GAP),
                    top: PADG + row * rowH,
                    width: cellW,
                    height: cellW,
                  };
                  const isSel = selected.has(p.id);
                  return (
                    <div
                      key={p.id}
                      style={cellStyle}
                      className={`cell ${isSel ? "selected" : ""} ${selectMode || selected.size > 0 ? "selectmode" : ""}`}
                      onClick={(e) => cellClick(p, idx, e)}
                      onContextMenu={(e) => {
                        if (!NATIVE) return;
                        e.preventDefault();
                        openContextMenu(p.id, e.clientX, e.clientY);
                      }}
                      onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
                      title={p.name}
                    >
                      <Thumb src={p.previewUrl || thumbURL(p)} alt={p.name} />
                      <div
                        className="check"
                        onClick={(e) => { e.stopPropagation(); toggleSelect(p.id); anchorIdx.current = idx; }}
                      >
                        {isSel && I.check}
                      </div>
                      {p.edits && <div className="badge">Edited</div>}
                      {p.rating > 0 && <div className="rbadge">{"★".repeat(p.rating)}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {dragOver && <div className="dropveil">Drop photos or folders to import</div>}
        </div>
      </div>

      {editingPhoto && (
        <Editor
          key={editingPhoto.id}
          photo={editingPhoto}
          siblings={editorSiblings}
          suppressKeys={!!exportItems}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onClose={() => setEditingId(null)}
          onApply={applyEdits}
          onSwitch={switchEditing}
          onExport={openExportFromEditor}
          onExportSelected={exportSelected}
          selected={selected}
          onToggleSel={toggleSelect}
          onRangeSel={rangeSelect}
          onContextExport={NATIVE ? openContextMenu : null}
          onRate={setRating}
          toast={toast}
        />
      )}

      {exportItems && (
        <ExportDialog
          items={exportItems}
          onClose={() => setExportItems(null)}
          onSavePreset={NATIVE ? savePreset : null}
          presets={NATIVE ? presets : []}
          onRunPreset={(pr) => {
            const ids = exportItems.map((i) => i.photo.id);
            setExportItems(null);
            runPreset(pr, ids);
          }}
          toast={toast}
        />
      )}

      {ctxMenu && ctxMenu.type === "folder" && (
        <CtxMenu x={ctxMenu.x} y={ctxMenu.y}>
          <div className="cm-title">{ctxMenu.name}</div>
          <div
            className="cm-item"
            onClick={() => { const f = ctxMenu.label; setCtxMenu(null); removeFolder(f); }}
          >
            <div className="cm-main">
              <span className="cm-name" style={{ color: "var(--danger)" }}>Remove folder from library</span>
              <span className="cm-sub">files stay on disk</span>
            </div>
          </div>
        </CtxMenu>
      )}

      {ctxMenu && ctxMenu.type === "export" && (
        <CtxMenu x={ctxMenu.x} y={ctxMenu.y}>
          <div className="cm-title">Export {ctxMenu.ids.length > 1 ? `${ctxMenu.ids.length} photos` : "photo"}</div>
          {presets.map((pr) => (
            <div key={pr.id} className="cm-item" onClick={() => runPreset(pr, ctxMenu.ids)}>
              <div className="cm-main">
                <span className="cm-name">{pr.name}</span>
                <span className="cm-sub">≤{pr.targetMB} MB · {pr.format.toUpperCase()} · {pr.scale}% → {baseName(pr.dir)}</span>
              </div>
              <button
                className="cm-del"
                title="Delete preset"
                onClick={(e) => { e.stopPropagation(); deletePreset(pr.id); }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          ))}
          {presets.length === 0 && (
            <div className="cm-empty">No presets yet — create one in the export dialog</div>
          )}
          <div className="cm-sep" />
          <div
            className="cm-item"
            onClick={() => {
              const items = photosRef.current
                .filter((p) => ctxMenu.ids.includes(p.id))
                .map((p) => ({ photo: p, edits: p.edits }));
              setCtxMenu(null);
              if (items.length) setExportItems(items);
            }}
          >
            <div className="cm-main"><span className="cm-name">Export with settings…</span></div>
          </div>
        </CtxMenu>
      )}

      {busyExport && <div className="toast">{busyExport}</div>}
      {toastMsg && !busyExport && (
        <div className="toast">
          {toastMsg.text}
          {toastMsg.action && (
            <button
              className="toast-act"
              onClick={() => { const fn = toastMsg.action.fn; setToastMsg(null); fn(); }}
            >
              {toastMsg.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
