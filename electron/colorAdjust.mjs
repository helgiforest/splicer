/* ============================================================
   Shared tone/color adjustment math — used by:
     - the live WebGL preview shader in src/App.jsx (GLSL twin,
       marked "KEEP IN SYNC WITH electron/colorAdjust.mjs")
     - the renderer's CPU bake paths (bakePreview/bakeCanvas in
       src/App.jsx, thumbnails + browser-fallback export)
     - the native export pipeline (bakeRaw in electron/main.cjs)

   .mjs on purpose: Node always treats this as ESM regardless of
   package.json's missing "type": "module", so electron/main.cjs
   (CommonJS) can `await import()` it, while Vite bundles it for
   the renderer like any other ES module. Lives under electron/
   rather than src/ because electron-builder's `files` allowlist
   only packages "electron/**", not "src/**" — a src/ path would
   404 in a built app even though it works fine in dev.

   All strength constants below are eyeballed, not derived from
   any Adobe/Apple spec — expect a tuning pass. Known simplifications:
   white balance is a per-channel gain model (not a true Kelvin/CCT
   chromatic-adaptation transform), contrast is a linear pivot (not
   a parametric spline), and Highlights/Shadows/White Point operate on
   an already-clipped 8-bit sRGB buffer so they can lift/darken existing
   tones but can't reconstruct genuinely blown detail the way
   RAW-domain recovery can.
   ============================================================ */

const EV_RANGE = 2.5;              // exposure ±100% -> ±2.5 stops
const TEMP_STRENGTH = 0.45;        // temperature ±100% -> R/B gain swing
const TINT_STRENGTH = 0.35;        // tint ±100% -> G gain swing (+ light R/B trim)
const CONTRAST_STRENGTH = 1.0;     // contrast ±100% -> pivot factor 0..2
const HIGHLIGHT_STRENGTH = 0.9;
const SHADOW_STRENGTH = 0.9;
const BLACKPOINT_STRENGTH = 0.3;   // black point ±100% -> levels shift (floor)
const WHITEPOINT_STRENGTH = 0.3;   // white point ±100% -> levels shift (ceiling)
const SATURATION_STRENGTH = 1.0;   // saturation ±100% -> uniform gain 0..2 on distance from gray

export function defaultAdjust() {
  return {
    temp: 0, tint: 0, saturation: 0,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0,
    whitePoint: 0, blackPoint: 0,
  };
}

export function isDefaultAdjust(adjust) {
  if (!adjust) return true;
  return (
    (adjust.temp || 0) === 0 &&
    (adjust.tint || 0) === 0 &&
    (adjust.saturation || 0) === 0 &&
    (adjust.exposure || 0) === 0 &&
    (adjust.contrast || 0) === 0 &&
    (adjust.highlights || 0) === 0 &&
    (adjust.shadows || 0) === 0 &&
    (adjust.whitePoint || 0) === 0 &&
    (adjust.blackPoint || 0) === 0
  );
}

/* Maps -100..100 slider values to the derived numbers the per-pixel
   apply step actually uses. This is the single source of truth for
   what each slider % means — both the CPU path (adjustPixel below)
   and the GLSL shader consume exactly these derived values (as
   uniforms), so only the small final apply formula needs a
   hand-mirrored GLSL twin, not this mapping. */
export function compileAdjust(adjust) {
  const a = { ...defaultAdjust(), ...(adjust || {}) };
  const temp = a.temp / 100;
  const tint = a.tint / 100;
  return {
    wbGainR: 1 + temp * TEMP_STRENGTH + tint * TINT_STRENGTH * 0.3,
    wbGainG: 1 - tint * TINT_STRENGTH,
    wbGainB: 1 - temp * TEMP_STRENGTH + tint * TINT_STRENGTH * 0.3,
    satGain: 1 + (a.saturation / 100) * SATURATION_STRENGTH,
    exposureGain: Math.pow(2, (a.exposure / 100) * EV_RANGE),
    contrastAmt: (a.contrast / 100) * CONTRAST_STRENGTH,
    highlightGain: (a.highlights / 100) * HIGHLIGHT_STRENGTH,
    shadowGain: (a.shadows / 100) * SHADOW_STRENGTH,
    whiteShift: (a.whitePoint / 100) * WHITEPOINT_STRENGTH,
    blackShift: -(a.blackPoint / 100) * BLACKPOINT_STRENGTH,
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* r,g,b: 0-255 in, 0-255 out. `c` is a compileAdjust() result.
   KEEP IN SYNC WITH the GLSL fragment shader in src/App.jsx (GLImage). */
export function adjustPixel(r, g, b, c) {
  let cr = r / 255, cg = g / 255, cb = b / 255;

  // white balance
  cr *= c.wbGainR; cg *= c.wbGainG; cb *= c.wbGainB;

  // saturation: scale each channel's distance from the pixel's own gray
  // (luminance) value
  if (c.satGain !== 1) {
    const gray = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    cr = gray + (cr - gray) * c.satGain;
    cg = gray + (cg - gray) * c.satGain;
    cb = gray + (cb - gray) * c.satGain;
  }

  // exposure: uniform stops-based gain, moves the black point
  cr *= c.exposureGain; cg *= c.exposureGain; cb *= c.exposureGain;

  // contrast: linear pivot around mid-gray
  cr = (cr - 0.5) * (1 + c.contrastAmt) + 0.5;
  cg = (cg - 0.5) * (1 + c.contrastAmt) + 0.5;
  cb = (cb - 0.5) * (1 + c.contrastAmt) + 0.5;

  // highlights / shadows: luma-masked lift (positive) or recovery
  // (negative), one shared mask across a pixel's own R/G/B channels (not
  // a per-channel independent mask) so a highlight/shadow move can't
  // shift hue the way adjusting each channel by its own separate amount
  // would. Shadows recomputes luminance AFTER highlights has already run
  // (rather than reusing highlights' own `lum`) — the two operate on
  // genuinely different tonal ranges (0.35-1.0 vs 0.0-0.5, minimal
  // overlap) so this rarely matters in practice, but it's the actually-
  // correct order: each step should see the pixel as the PREVIOUS step
  // actually left it, not a stale reading from before that step ran.
  if (c.highlightGain !== 0) {
    const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    const d = smoothstep(0.35, 1.0, lum) * c.highlightGain;
    cr += d >= 0 ? d * (1 - cr) : d * cr;
    cg += d >= 0 ? d * (1 - cg) : d * cg;
    cb += d >= 0 ? d * (1 - cb) : d * cb;
  }
  if (c.shadowGain !== 0) {
    const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    const d = (1 - smoothstep(0.0, 0.5, lum)) * c.shadowGain;
    cr += d >= 0 ? d * (1 - cr) : d * cr;
    cg += d >= 0 ? d * (1 - cg) : d * cg;
    cb += d >= 0 ? d * (1 - cb) : d * cb;
  }

  // black point / white point: levels-style remap of the [lo, hi] range to
  // [0, 1]. Positive blackPoint lifts/lightens shadows (raises the floor,
  // reduces contrast); negative crushes blacks. Positive whitePoint pulls
  // the ceiling down (clips/brightens highlights, more contrast); negative
  // pushes it up (recovers/dims highlights, less contrast).
  if (c.blackShift !== 0 || c.whiteShift !== 0) {
    const lo = c.blackShift, hi = 1 - c.whiteShift;
    const denom = Math.max(0.05, hi - lo);
    cr = (cr - lo) / denom;
    cg = (cg - lo) / denom;
    cb = (cb - lo) / denom;
  }

  return [
    Math.round(Math.min(1, Math.max(0, cr)) * 255),
    Math.round(Math.min(1, Math.max(0, cg)) * 255),
    Math.round(Math.min(1, Math.max(0, cb)) * 255),
  ];
}

/* Mutates buf in place (works on a Node Buffer or a Uint8ClampedArray
   alike) and returns it. Only touches the first 3 bytes/pixel — alpha,
   if present, is left untouched. No-ops (and skips the compile step)
   when adjust is at defaults, so crop-only edits pay zero extra cost. */
export function applyAdjustToRGBBuffer(buf, width, height, channels, adjust) {
  if (isDefaultAdjust(adjust)) return buf;
  const c = compileAdjust(adjust);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const [r, g, b] = adjustPixel(buf[o], buf[o + 1], buf[o + 2], c);
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
  }
  return buf;
}
