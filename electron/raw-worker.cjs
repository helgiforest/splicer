/* dcraw runs synchronously (wasm) and can take seconds on a big RAW —
   in a worker thread it no longer freezes the app's main process */
const { parentPort } = require("worker_threads");
const fs = require("fs");

parentPort.on("message", ({ id, op, path }) => {
  try {
    const dcraw = require("dcraw");
    const buf = fs.readFileSync(path);
    let out = null;
    if (op === "thumb") out = dcraw(buf, { extractThumbnail: true });
    else if (op === "tiff") out = dcraw(buf, { exportAsTiff: true });
    parentPort.postMessage({ id, data: out ? Buffer.from(out) : null });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e) });
  }
});
