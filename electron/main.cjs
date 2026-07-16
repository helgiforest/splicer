const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const { pathToFileURL } = require("url");

const NATIVE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;   // Chromium decodes these itself
const TIFF_RE = /\.(tif|tiff)$/i;
const HEIC_RE = /\.(heic|heif)$/i;
const RAW_RE = /\.(cr2|cr3|nef|nrw|arw|srf|sr2|orf|rw2|raf|dng|pef|srw|erf|kdc|3fr|mrw|x3f)$/i;
const IMG_RE = new RegExp(
  `(${NATIVE_RE.source}|${TIFF_RE.source}|${HEIC_RE.source}|${RAW_RE.source})`, "i"
);
const isImg = (name) => IMG_RE.test(name);
const libFile = () => path.join(app.getPath("userData"), "library.json");
const convCacheDir = () => path.join(app.getPath("userData"), "converted");
const thumbCacheDir = () => path.join(app.getPath("userData"), "thumbs");
const proxyCacheDir = () => path.join(app.getPath("userData"), "proxies");


/* editor proxy: ~3200px working copy. The editor never touches the
   full-resolution original directly, so a 200-MP file pans and zooms
   exactly as fluidly as a 12-MP one; deep-zoom sharpness is restored
   by on-demand tiles (see render-tile). */
const proxyInflight = new Map();
const PROXY_LONG = 3200;
async function proxyFor(p) {
  const st = await fsp.stat(p);
  const key = crypto.createHash("md5").update(`px|${p}|${st.size}|${st.mtimeMs}`).digest("hex");
  await fsp.mkdir(proxyCacheDir(), { recursive: true });
  const out = path.join(proxyCacheDir(), key + ".jpg");
  if (fs.existsSync(out)) return out;
  if (proxyInflight.has(out)) return proxyInflight.get(out);
  const job = (async () => {
    const src = needsConvert(p) ? await convertOnce(p) : p;
    await acquireSlot();
    try {
      const sharp = require("sharp");
      await sharp(src, { limitInputPixels: false })
        .rotate()
        .resize(PROXY_LONG, PROXY_LONG, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .withMetadata()
        .toFile(out);
      return out;
    } finally {
      releaseSlot();
    }
  })().finally(() => proxyInflight.delete(out));
  proxyInflight.set(out, job);
  return job;
}

/* small on-disk thumbnails so the library grid never loads 45-MP originals */
const thumbInflight = new Map();
async function thumbFor(p) {
  const st = await fsp.stat(p);
  const key = crypto.createHash("md5").update(`t|${p}|${st.size}|${st.mtimeMs}`).digest("hex");
  await fsp.mkdir(thumbCacheDir(), { recursive: true });
  const out = path.join(thumbCacheDir(), key + ".jpg");
  if (fs.existsSync(out)) return out;
  if (thumbInflight.has(out)) return thumbInflight.get(out);
  const job = (async () => {
    // convertOnce has its own queue slot — resolve it first to avoid
    // two thumb jobs holding both slots while waiting for conversion
    const src = needsConvert(p) ? await convertOnce(p) : p;
    await acquireSlot();
    try {
      const sharp = require("sharp");
      await sharp(src, { limitInputPixels: false })
        .rotate()
        .resize(512, 512, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(out);
      return out;
    } finally {
      releaseSlot();
    }
  })().finally(() => thumbInflight.delete(out));
  thumbInflight.set(out, job);
  return job;
}

/* ---------------- TIFF / RAW / HEIC → displayable JPEG/PNG ----------------
   Chromium can't decode these, so the photo:// protocol converts them in
   the main process and caches the result on disk (keyed by path+size+mtime,
   so an edited-on-disk file re-converts automatically). Heavy decodes run
   through a small queue so a folder of RAWs doesn't eat all the RAM. */

const crypto = require("crypto");

/* dcraw worker (see raw-worker.cjs): keeps the main process responsive */
const { Worker } = require("worker_threads");
let rawWorker = null, rawSeq = 0;
const rawPending = new Map();
function dcrawInWorker(op, filePath) {
  if (!rawWorker) {
    rawWorker = new Worker(path.join(__dirname, "raw-worker.cjs"));
    rawWorker.on("message", (m) => {
      const pend = rawPending.get(m.id);
      if (!pend) return;
      rawPending.delete(m.id);
      m.error ? pend.reject(new Error(m.error)) : pend.resolve(m.data ? Buffer.from(m.data) : null);
    });
    rawWorker.on("error", () => {
      for (const pend of rawPending.values()) pend.reject(new Error("raw worker crashed"));
      rawPending.clear();
      rawWorker = null;
    });
  }
  const id = ++rawSeq;
  return new Promise((resolve, reject) => {
    rawPending.set(id, { resolve, reject });
    rawWorker.postMessage({ id, op, path: filePath });
  });
}
const inflight = new Map(); // path -> Promise<convertedPath>
let convActive = 0;
const convWaiters = [];
const acquireSlot = () =>
  new Promise((res) => {
    if (convActive < 2) { convActive++; res(); }
    else convWaiters.push(res);
  });
const releaseSlot = () => {
  convActive--;
  const next = convWaiters.shift();
  if (next) { convActive++; next(); }
};

/* generic rescue: many RAWs (incl. CR3) carry a full-size JPEG preview;
   find the largest well-formed JPEG segment in the raw bytes */
function largestEmbeddedJpeg(buf) {
  let best = null;
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      const end = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 3);
      if (end > i) {
        const len = end + 2 - i;
        if (!best || len > best.len) best = { start: i, len };
        i = end + 1;
      }
    }
  }
  return best && best.len > 50 * 1024 ? buf.subarray(best.start, best.start + best.len) : null;
}

async function convertToDisplayable(p) {
  const st = await fsp.stat(p);
  const key = crypto.createHash("md5").update(`${p}|${st.size}|${st.mtimeMs}`).digest("hex");
  await fsp.mkdir(convCacheDir(), { recursive: true });
  const jpgPath = path.join(convCacheDir(), key + ".jpg");
  const pngPath = path.join(convCacheDir(), key + ".png");
  if (fs.existsSync(jpgPath)) return jpgPath;
  if (fs.existsSync(pngPath)) return pngPath;

  await acquireSlot();
  try {
    const buf = await fsp.readFile(p);

    if (HEIC_RE.test(p)) {
      const heicConvert = require("heic-convert");
      const out = await heicConvert({ buffer: buf, format: "JPEG", quality: 0.92 });
      await fsp.writeFile(jpgPath, Buffer.from(out));
      return jpgPath;
    }

    if (TIFF_RE.test(p)) {
      const sharp = require("sharp");
      const meta = await sharp(buf, { limitInputPixels: false }).metadata();
      if (meta.hasAlpha) {
        await sharp(buf, { limitInputPixels: false }).png().withMetadata().toFile(pngPath);
        return pngPath;
      }
      await sharp(buf, { limitInputPixels: false }).jpeg({ quality: 97, chromaSubsampling: "4:4:4" }).withMetadata().toFile(jpgPath);
      return jpgPath;
    }

    if (RAW_RE.test(p)) {
      // 1) embedded full-size preview via dcraw in a worker thread
      try {
        const thumb = await dcrawInWorker("thumb", p);
        if (thumb && thumb.length > 20 * 1024 && thumb[0] === 0xff && thumb[1] === 0xd8) {
          await fsp.writeFile(jpgPath, thumb);
          return jpgPath;
        }
      } catch {}
      // 2) full raw development (worker thread), stored as JPEG q97 —
      //    a 45-MP PNG decodes painfully slowly, JPEG keeps things fluid
      try {
        const tiff = await dcrawInWorker("tiff", p);
        if (tiff && tiff.length) {
          const sharp = require("sharp");
          await sharp(tiff, { limitInputPixels: false })
            .jpeg({ quality: 97, chromaSubsampling: "4:4:4" })
            .withMetadata()
            .toFile(jpgPath);
          return jpgPath;
        }
      } catch {}
      // 3) last resort (covers CR3 and other formats dcraw predates):
      //    scan the file for its largest embedded JPEG
      const jpeg = largestEmbeddedJpeg(buf);
      if (jpeg) {
        await fsp.writeFile(jpgPath, jpeg);
        return jpgPath;
      }
      throw new Error("raw decode failed");
    }

    throw new Error("unsupported format");
  } finally {
    releaseSlot();
  }
}

function convertOnce(p) {
  if (inflight.has(p)) return inflight.get(p);
  const job = convertToDisplayable(p).finally(() => inflight.delete(p));
  inflight.set(p, job);
  return job;
}

let mainWindow = null;

/* Custom protocol so the renderer can display photos straight from disk */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "photo",
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

async function scanDir(dir, folderLabel, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // no permission for a subfolder — skip it
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await scanDir(full, `${folderLabel}/${e.name}`, out);
    } else if (e.isFile() && isImg(e.name)) {
      let size = 0, mtime = 0;
      try {
        const st = await fsp.stat(full);
        size = st.size; mtime = st.mtimeMs;
      } catch {}
      out.push({ path: full, name: e.name, folder: folderLabel, size, mtime });
    }
  }
}

/* ---------------- folder watching ---------------- */

const watchers = new Map();   // root -> { watcher, timer, poll }
const RECURSIVE_OK = process.platform !== "linux";

async function rescanAndNotify(root) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const records = [];
  await scanDir(root, path.basename(root), records);
  mainWindow.webContents.send("folder-scan", { root, records });
}

function scheduleScan(root) {
  const entry = watchers.get(root);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => rescanAndNotify(root), 1200);
}

function watchRoot(root) {
  if (watchers.has(root) || !fs.existsSync(root)) return;
  const entry = { watcher: null, timer: null, poll: null };
  try {
    entry.watcher = fs.watch(root, { recursive: RECURSIVE_OK }, () => scheduleScan(root));
    entry.watcher.on("error", () => {});
  } catch {
    /* watching unavailable — polling below still covers it */
  }
  // Linux fs.watch is not recursive; poll as a safety net
  if (!RECURSIVE_OK) {
    entry.poll = setInterval(() => rescanAndNotify(root), 15000);
  }
  watchers.set(root, entry);
}

function unwatchRoot(root) {
  const entry = watchers.get(root);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.poll) clearInterval(entry.poll);
  try { entry.watcher?.close(); } catch {}
  watchers.delete(root);
}

/* ---------------- window ---------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: "#0B0C0F",
    title: "Meridian",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));

  // Catch changes that happened while the app was in the background
  mainWindow.on("focus", () => {
    for (const root of watchers.keys()) scheduleScan(root);
  });
}

app.whenReady().then(() => {
  protocol.handle("photo", async (request) => {
    const rest = request.url.replace(/^photo:\/\//, "");
    const [encPath, query] = rest.split("?");
    const p = decodeURIComponent(encPath);
    try {
      if (query && query.includes("thumb")) {
        const t = await thumbFor(p);
        return net.fetch(pathToFileURL(t).toString());
      }
      if (query && query.includes("proxy")) {
        const pr = await proxyFor(p);
        return net.fetch(pathToFileURL(pr).toString());
      }
      if (NATIVE_RE.test(p)) return net.fetch(pathToFileURL(p).toString());
      const converted = await convertOnce(p);
      return net.fetch(pathToFileURL(converted).toString());
    } catch {
      // thumbnail failed (e.g. exotic format) — fall back to the original
      try {
        if (NATIVE_RE.test(p)) return net.fetch(pathToFileURL(p).toString());
      } catch {}
      return new Response("decode failed", { status: 415 });
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------------- IPC: importing ---------------- */

ipcMain.handle("pick-files", async () => {
  const res = await dialog.showOpenDialog({
    title: "Import photos",
    properties: ["openFile", "multiSelections"],
    filters: [{
      name: "Images",
      extensions: [
        "jpg", "jpeg", "png", "webp", "gif", "avif", "bmp",
        "tif", "tiff", "heic", "heif",
        "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "orf", "rw2",
        "raf", "dng", "pef", "srw", "erf", "kdc", "3fr", "mrw", "x3f",
      ],
    }],
  });
  if (res.canceled) return [];
  const out = [];
  for (const p of res.filePaths) {
    if (!isImg(p)) continue;
    let size = 0, mtime = 0;
    try {
      const st = await fsp.stat(p);
      size = st.size; mtime = st.mtimeMs;
    } catch {}
    out.push({ path: p, name: path.basename(p), folder: "", size, mtime });
  }
  return out;
});

/* Turn syncing on for a set of existing folder roots (e.g. folders that
   were imported before watching existed, or re-enabling from the sidebar) */
ipcMain.handle("watch-roots", (_e, roots) => {
  for (const r of roots || []) watchRoot(r);
  return [...watchers.keys()];
});

ipcMain.handle("pick-folder", async () => {
  const res = await dialog.showOpenDialog({
    title: "Import folder",
    properties: ["openDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return { root: null, records: [] };
  const dir = res.filePaths[0];
  const records = [];
  await scanDir(dir, path.basename(dir), records);
  watchRoot(dir); // keep the library in sync with this folder from now on
  return { root: dir, records };
});

/* Dropped items: mix of files and folders (absolute paths from the renderer) */
ipcMain.handle("import-paths", async (_e, paths) => {
  const records = [];
  const roots = [];
  for (const p of paths || []) {
    try {
      const st = await fsp.stat(p);
      if (st.isDirectory()) {
        await scanDir(p, path.basename(p), records);
        watchRoot(p);
        roots.push(p);
      } else if (st.isFile() && isImg(p)) {
        records.push({ path: p, name: path.basename(p), folder: "", size: st.size, mtime: st.mtimeMs });
      }
    } catch {
      /* skip unreadable */
    }
  }
  return { records, roots };
});

ipcMain.handle("unwatch-root", (_e, root) => {
  unwatchRoot(root);
  return true;
});

/* ---------------- IPC: persistent library ---------------- */

ipcMain.handle("load-library", async () => {
  try {
    const raw = await fsp.readFile(libFile(), "utf8");
    const parsed = JSON.parse(raw);
    // legacy format was a plain array of items
    const items = Array.isArray(parsed) ? parsed : parsed.items || [];
    const savedRoots = Array.isArray(parsed) ? [] : parsed.watchedRoots || [];
    const alive = [];
    let missing = 0;
    for (const it of items) {
      if (!it || !it.path) { missing++; continue; }
      try {
        const st = fs.statSync(it.path);
        it.sizeBytes = st.size;      // always refresh: the file may have
        it.size = st.size;           // been replaced on disk since import
        it.mtime = st.mtimeMs;
        alive.push(it);
      } catch {
        missing++;
      }
    }
    for (const root of savedRoots) watchRoot(root);
    const settings = Array.isArray(parsed) ? {} : parsed.settings || {};
    return { items: alive, missing, watchedRoots: [...watchers.keys()], settings };
  } catch {
    return { items: [], missing: 0, watchedRoots: [], settings: {} };
  }
});

ipcMain.handle("save-library", async (_e, items, settings) => {
  try {
    const payload = { items, watchedRoots: [...watchers.keys()], settings: settings || {} };
    await fsp.writeFile(libFile(), JSON.stringify(payload), "utf8");
    return true;
  } catch {
    return false;
  }
});

/* ---------------- IPC: export to disk ---------------- */

/* --------------------------------------------------------------
   Export engine v2 — sharp + MozJPEG.
   The final encode no longer uses the browser's canvas codec:
   sharp applies the crop/rotation losslessly on raw pixels and
   encodes with MozJPEG (best quality-per-byte JPEG encoder in
   production use) or high-effort WebP. Quality is binary-searched
   natively, which is much faster than canvas re-encodes.
   -------------------------------------------------------------- */

const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
const needsConvert = (p) => TIFF_RE.test(p) || HEIC_RE.test(p) || RAW_RE.test(p);

/* bake one photo (with its non-destructive edits) to raw RGB at the
   requested output scale; returns { data, info } */
async function bakeRaw(item, scalePct) {
  const sharp = require("sharp");
  const src = needsConvert(item.path) ? await convertOnce(item.path) : item.path;
  // stage 1: decode + EXIF auto-orient
  const oriented = await sharp(src, { limitInputPixels: false })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let base = oriented;
  const e = item.edits;
  let cw = base.info.width, ch = base.info.height, cx = cw / 2, cy = ch / 2;
  if (e) {
    if (Math.abs(e.theta) > 0.01) {
      base = await sharp(oriented.data, {
        raw: { width: oriented.info.width, height: oriented.info.height, channels: oriented.info.channels },
        limitInputPixels: false,
      })
        .rotate(e.theta, { background: { r: 0, g: 0, b: 0 } })
        .raw()
        .toBuffer({ resolveWithObject: true });
    }
    const t = (e.theta * Math.PI) / 180;
    cx = base.info.width / 2 + (e.qcx * Math.cos(t) - e.qcy * Math.sin(t));
    cy = base.info.height / 2 + (e.qcx * Math.sin(t) + e.qcy * Math.cos(t));
    cw = Math.round(e.cw);
    ch = Math.round(e.ch);
  }
  let left = Math.round(cx - cw / 2), top = Math.round(cy - ch / 2);
  cw = clampN(cw, 1, base.info.width);
  ch = clampN(ch, 1, base.info.height);
  left = clampN(left, 0, base.info.width - cw);
  top = clampN(top, 0, base.info.height - ch);
  let pipe = sharp(base.data, {
    raw: { width: base.info.width, height: base.info.height, channels: base.info.channels },
    limitInputPixels: false,
  }).extract({ left, top, width: cw, height: ch });
  const outW = Math.max(1, Math.round(cw * (scalePct / 100)));
  if (outW !== cw) pipe = pipe.resize(outW);
  return pipe.raw().toBuffer({ resolveWithObject: true });
}

function encoderFor(rawObj, format, meta) {
  const sharp = require("sharp");
  const opts = { raw: { width: rawObj.info.width, height: rawObj.info.height, channels: rawObj.info.channels } };
  // withMetadata() always attaches an sRGB ICC profile (correct colors on
  // wide-gamut displays); meta.exif optionally carries key camera fields
  const md = meta && meta.exif ? { exif: meta.exif } : {};
  return (q) =>
    format === "webp"
      ? sharp(rawObj.data, opts).webp({ quality: q, effort: 5 }).withMetadata(md).toBuffer()
      : sharp(rawObj.data, opts)
          .jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? "4:4:4" : "4:2:0" })
          .withMetadata(md)
          .toBuffer();
}

/* binary-search encoder quality to fit targetBytes; quality can reach 100 —
   if even that is under the target, the file simply cannot get better */
async function encodeToTarget(rawObj, format, targetBytes, meta) {
  const enc = encoderFor(rawObj, format, meta);
  let lo = 5, hi = 100;
  let buf = await enc(hi);
  if (buf.length <= targetBytes) return { buf, quality: hi, over: false, maxed: true };
  let bufLo = await enc(lo);
  if (bufLo.length > targetBytes) return { buf: bufLo, quality: lo, over: true, maxed: false };
  let best = { buf: bufLo, quality: lo, over: false, maxed: false };
  for (let i = 0; i < 7 && lo < hi - 1; i++) {
    const mid = Math.round((lo + hi) / 2);
    const b = await enc(mid);
    if (b.length <= targetBytes) { best = { buf: b, quality: mid, over: false, maxed: false }; lo = mid; }
    else hi = mid;
  }
  return best;
}

/* small cache so the estimate dialog doesn't re-bake on every keystroke */
const bakeCache = new Map(); // key -> Promise<rawObj>
function bakeCached(item, scalePct) {
  const key = `${item.path}|${JSON.stringify(item.edits)}|${scalePct}`;
  if (bakeCache.has(key)) return bakeCache.get(key);
  const job = bakeRaw(item, scalePct);
  bakeCache.set(key, job);
  if (bakeCache.size > 4) bakeCache.delete(bakeCache.keys().next().value);
  return job;
}


/* deep-zoom tile: exact visible region of the ORIENTED original at the
   requested pixel density — snaps the proxy view to pixel sharpness */
ipcMain.handle("render-tile", async (_e, p, t) => {
  try {
    const sharp = require("sharp");
    const src = needsConvert(p) ? await convertOnce(p) : p;
    const sx = Math.max(0, Math.round(t.sx));
    const sy = Math.max(0, Math.round(t.sy));
    const sw = Math.max(4, Math.round(t.sw));
    const sh = Math.max(4, Math.round(t.sh));
    const dw = Math.min(4096, Math.max(8, Math.round(t.dw)));
    const buf = await sharp(src, { limitInputPixels: false })
      .rotate()
      .extract({ left: sx, top: sy, width: sw, height: sh })
      .resize({ width: dw })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
      .withMetadata()
      .toBuffer();
    return buf;
  } catch {
    return null;
  }
});

ipcMain.handle("read-exif", async (_e, p) => {
  try {
    const exifr = require("exifr");
    const d = await exifr.parse(p, {
      pick: ["Make", "Model", "LensModel", "ISO", "ExposureTime", "FNumber", "FocalLength", "DateTimeOriginal"],
    });
    if (!d) return null;
    return {
      make: d.Make || null,
      model: d.Model || null,
      lens: d.LensModel || null,
      iso: d.ISO || null,
      exposure: d.ExposureTime || null,
      fnumber: d.FNumber || null,
      focal: d.FocalLength || null,
      taken: d.DateTimeOriginal ? new Date(d.DateTimeOriginal).getTime() : null,
    };
  } catch {
    return null;
  }
});


/* minimal EXIF carry-over for "Keep EXIF" exports */
async function exifMetaFor(p) {
  try {
    const exifr = require("exifr");
    const d = await exifr.parse(p, { pick: ["Make", "Model", "DateTimeOriginal", "LensModel"] });
    if (!d) return null;
    const ifd0 = {};
    if (d.Make) ifd0.Make = String(d.Make);
    if (d.Model) ifd0.Model = String(d.Model);
    const exifIFD = {};
    if (d.DateTimeOriginal) {
      const dt = new Date(d.DateTimeOriginal);
      const pad = (n) => String(n).padStart(2, "0");
      exifIFD.DateTimeOriginal = `${dt.getFullYear()}:${pad(dt.getMonth() + 1)}:${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    }
    if (d.LensModel) exifIFD.LensModel = String(d.LensModel);
    const exif = {};
    if (Object.keys(ifd0).length) exif.IFD0 = ifd0;
    if (Object.keys(exifIFD).length) exif.IFD2 = exifIFD;
    return Object.keys(exif).length ? { exif } : null;
  } catch {
    return null;
  }
}

/* file name from template: {name}, {date} (file date, YYYY-MM-DD) */
function buildExportName(item, template, ext) {
  const base = item.name.replace(/\.[^.]+$/, "");
  let date = "";
  try {
    date = new Date(fs.statSync(item.path).mtimeMs).toISOString().slice(0, 10);
  } catch {}
  const tpl = (template || "{name}").trim() || "{name}";
  let name = tpl.split("{name}").join(base).split("{date}").join(date);
  if (tpl === "{name}" && item.edits) name += "-edited";
  name = name.replace(/[\\/:*?"<>|]/g, "-");
  return `${name}.${ext}`;
}

function uniquePath(dir, fileName) {
  let candidate = path.join(dir, fileName);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
}

ipcMain.handle("estimate-photo", async (_e, item, opts) => {
  try {
    const raw = await bakeCached(item, opts.scale);
    const meta = opts.keepExif ? await exifMetaFor(item.path) : null;
    const res = await encodeToTarget(raw, opts.format, opts.targetMB * 1024 * 1024, meta);
    return { size: res.buf.length, quality: res.quality, over: res.over, maxed: res.maxed, w: raw.info.width, h: raw.info.height };
  } catch (err) {
    return { error: String(err) };
  }
});

ipcMain.handle("pick-dir", async () => {
  const res = await dialog.showOpenDialog({
    title: "Choose export folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});

ipcMain.handle("export-photos", async (event, items, opts) => {
  let dir = opts.dir || null;
  const ext = opts.format === "webp" ? "webp" : "jpg";
  if (!dir) {
    if (items.length === 1) {
      const res = await dialog.showSaveDialog({
        title: "Export photo",
        defaultPath: buildExportName(items[0], opts.template, ext),
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      const raw = await bakeCached(items[0], opts.scale);
      const meta = opts.keepExif ? await exifMetaFor(items[0].path) : null;
      const enc = await encodeToTarget(raw, opts.format, opts.targetMB * 1024 * 1024, meta);
      await fsp.writeFile(res.filePath, enc.buf);
      return { ok: true, dir: path.dirname(res.filePath), exported: 1 };
    }
    const res = await dialog.showOpenDialog({
      title: "Choose export folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    dir = res.filePaths[0];
  }
  await fsp.mkdir(dir, { recursive: true });
  let exported = 0, failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    event.sender.send("export-progress", { done: i, total: items.length, name: it.name });
    try {
      const raw = await bakeCached(it, opts.scale);
      const meta = opts.keepExif ? await exifMetaFor(it.path) : null;
      const enc = await encodeToTarget(raw, opts.format, opts.targetMB * 1024 * 1024, meta);
      await fsp.writeFile(uniquePath(dir, buildExportName(it, opts.template, ext)), enc.buf);
      exported++;
    } catch {
      failed++;
    }
  }
  event.sender.send("export-progress", { done: items.length, total: items.length });
  return { ok: true, dir, exported, failed };
});

/* legacy path used by the browser-fallback renderer */

ipcMain.handle("export-files", async (_e, files) => {
  if (!files || !files.length) return { canceled: true };

  if (files.length === 1) {
    const res = await dialog.showSaveDialog({
      title: "Export photo",
      defaultPath: files[0].name,
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fsp.writeFile(res.filePath, Buffer.from(files[0].data));
    return { ok: true, dir: path.dirname(res.filePath) };
  }

  const res = await dialog.showOpenDialog({
    title: "Choose export folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  const dir = res.filePaths[0];
  for (const f of files) {
    await fsp.writeFile(path.join(dir, f.name), Buffer.from(f.data));
  }
  return { ok: true, dir };
});
