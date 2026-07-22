/* ============================================================
   Clone stamp math — used by:
     - the live WebGL preview in src/App.jsx (GLImage composites this
       CPU-side, per texture upload, rather than reimplementing it in
       the shader — see GLImage's texture-upload effect)
     - the renderer's CPU bake paths (bakePreview/bakeCanvas in
       src/App.jsx, thumbnails + browser-fallback export)
     - the native export pipeline (bakeRaw in electron/main.cjs)

   .mjs on purpose — see electron/colorAdjust.mjs's header for the
   full rationale (Node always treats this as ESM regardless of
   package.json's missing "type": "module", so electron/main.cjs
   can `await import()` it while Vite bundles it for the renderer;
   lives under electron/ because electron-builder only packages
   "electron/**").

   Algorithm: feathered clone along a swept "capsule" (a brush stroke's
   own polyline, thickened by radius with round ends), NOT a chain of
   independently-blended circular dabs, and NOT full Poisson/gradient-
   domain blending or Mean-Value Coordinates. `stamp` is an array of
   brush STROKES — { points: [{x,y,dx?,dy?}, ...], radius, dx, dy,
   feather, opacity } — a stroke is a path of brush POINTS sharing one
   radius, one rigid nominal source offset (dx,dy = source −
   destination, same as dragging one source handle for the whole brush
   in Lightroom's Heal brush, or the source point in Photoshop's Clone
   Stamp), one feather amount (falloff-zone width as a fraction of
   radius) and one opacity (0..1, how fully the clone replaces the
   original even at the stroke's own centerline). A point's own dx/dy,
   when present, overrides the stroke's for that one point only — set
   once at paint time (StampOverlay's self-overlap search: a curved
   stroke's rigid offset can otherwise sample from a destination this
   same stroke already painted a moment earlier, a visible seam), then
   replayed identically forever after like any other stored geometry.
   A plain circular dab is just a one-point stroke.

   Every destination PIXEL within a stroke's footprint is blended
   EXACTLY ONCE: for each pixel we find the closest point on the
   stroke's own polyline (iterating its line segments, not its stored
   points — the distance is to the nearest point on any segment, which
   is what actually makes the covered area a smooth capsule instead of
   a chain of separate circles), linearly interpolate that segment's
   two endpoints' offset/color-match data by the projection parameter,
   and blend once using that. Two earlier per-dab designs are
   deliberately NOT done anymore, because each read as a real, visible
   artifact rather than a clean removal:
     1. Blending a chain of overlapping circular dabs one at a time
        (each stroke point its own independent feathered clone). Two
        problems: the covered silhouette scallops (bulges at each dab
        center, pinches between them) instead of reading as one smooth
        brush stroke, AND a pixel inside more than one dab's radius —
        the normal case, since dabs are spaced well under 2×radius
        apart on purpose, for continuous coverage — got blended
        AGAIN by every subsequent overlapping dab, compounding opacity
        and (worse) drifting the per-dab color-match correction along
        the stroke instead of applying one consistent correction.
     2. Recomputing each dab's color-match ring against the buffer as
        it stood after EARLIER dabs of the SAME stroke had already
        written to it (when their footprints overlapped, which is the
        common case) — a color-match offset computed against
        partially-already-corrected pixels, repeated many times down a
        long stroke, could drift.
   Both are avoided by computing every point's own color-match offset
   once, up front, against a single immutable pre-stroke snapshot (the
   whole-stroke generalization of the same read-before-write split a
   single dab already needed — see applyStrokeToBuffer below), then
   touching each destination pixel only once during the fill.

   For color matching we sample the SOURCE's own area and the
   DESTINATION's *surrounding context* (per polyline POINT, not per
   pixel — cheap, same cost as the old per-dab version), take the
   median-RGB difference between the two, and add that offset to the
   copied source pixels; the result is blended against the untouched
   destination with a smoothstep feather. This is still O(stroke
   footprint) with no linear system to solve, and cheap enough to run on
   the CPU on every stroke edit (see below on why that matters).

   The source and destination samples are DELIBERATELY asymmetric, and
   that asymmetry is the whole point, not an oversight:
     - SOURCE: mostly the DISK itself (several concentric bands spanning
       its interior, more samples on the outer, larger-circumference
       bands so the sample stays roughly even per unit area) plus a
       modest margin just past its boundary. This should reflect what's
       actually being copied — sampling it is correct because the disk
       IS the content in question.
     - DESTINATION: the opposite — a ring OUTSIDE the disk+feather zone,
       never the disk's own interior. The destination sample's whole
       purpose is "what should this area blend into", and by definition
       that can't come from the disk's own current pixels: the disk is
       exactly the region the user is painting OVER, i.e. whatever
       defect/object is being removed. Sampling the disk for this
       (an earlier version did) meant painting over something strongly-
       colored — a green leaf on gray pavement — computed a "target tone"
       that was itself green, then nudged the clean copied source TOWARD
       that green, coming out visibly tinted by the very thing being
       erased. The fix mirrors the *opposite* of the lesson below: the
       source wants disk-interior sampling because the disk IS the
       target content; the destination wants ring sampling because the
       disk is NOT the target content, it's the removal target.

   Earlier version sampled a single thin RING just outside each circle
   for BOTH source and destination — reasoning that the ring shows
   "clean surroundings" while the disk might contain whatever defect is
   being removed. That reasoning doesn't hold for the SOURCE side once
   the ring itself is the unrepresentative one: on real, spatially-
   varying texture (sand, gravel, grass) the handful of points on one
   thin ring can land on a patch that reads a bit greener or pinker than
   the circle's own actual content, and the correction it computes then
   gets applied across the WHOLE copied disk — reported by the user as
   the destination coming out visibly tinted "every other time" even
   though the source circle itself looked completely normal. Weighting
   the SOURCE sample toward the disk's own interior (median, so a small
   defect occupying a minority of the disk still gets ignored) fixed
   that. DEST_AREA_BANDS keeps the destination on the ring side of that
   same lesson, widened (several bands, not one thin ring) for the same
   robustness-to-texture reason the source's own bands were widened.

   DIRECTIONAL color match, not just one flat offset per point: a single
   scalar correction (the median-of-the-whole-ring approach above) is
   still only "the average of what's around the disk" — right next to a
   genuinely asymmetric boundary (a lip's edge, a hard shadow line) the
   true surrounding color is NOT uniform around the circle, and forcing
   the whole disk toward one flat average leaves a visible ring exactly
   where reported: a soft, uniformly-toned "areola" that reads as an
   obviously separate patch rather than a seamless continuation of the
   skin, because the real neighboring skin is reddish on the lip-facing
   side and plain tan on the far side, and the flat correction can only
   match one of those (or split the difference and match neither). Fixed
   by bucketing DEST_AREA_BANDS' own samples into DEST_ANGULAR_BINS
   angular sectors (destContext below) instead of pooling them into one
   median, giving a per-DIRECTION destination estimate around the disk.
   Each point's stored correction becomes: the same flat median offset as
   before (dr/dg/db, still the anchor value used at the disk's own
   center), PLUS a per-angle DEVIATION from that flat value (how much
   this particular direction's true surroundings differ from the overall
   average), applied to each destination pixel scaled by a radial weight
   that is 0 at the disk's center and ramps to 1 at its boundary
   (smoothstep(0, radius, dist) — reusing the same falloff shape already
   used for the opacity feather, just over the disk radius instead of the
   feather zone). Net effect: the CENTER of a clone still gets one stable
   overall correction exactly like before (regressions-safe on the
   uniform-background case this module's existing tests all use), while
   the EDGE of the disk smoothly leans toward whatever is actually
   adjacent at each angle — which is exactly the boundary condition a
   real Poisson/gradient-domain solve enforces exactly, approximated here
   by harmonic-ish angular interpolation instead of solving a linear
   system: still O(sample count) per point, no matrix to build or invert,
   cheap enough for the same "recompute on every stroke edit" budget.
   Bin-level corrections get the same COLOR_OFFSET_CAP clamp as the flat
   value, and the deviation itself (bin correction minus flat correction)
   gets its own DEVIATION_CAP on top — a single noisy or small-sample bin
   (can happen near a photo edge, where out-of-bounds ring points get
   dropped) is bounded from swinging the local result too far off the
   flat anchor.

   DITHERED feather, not a continuous cross-fade: even with tone matched
   well (directional or not), blending clone and original pixel VALUES
   continuously across the feather ring (radius..outer) — the obvious
   `original*(1-a) + clone*a` — averages two INDEPENDENT realizations of
   photographic grain/noise together. Averaging independent noise reduces
   its variance, so the transition ring itself comes out visibly smoother
   / lower-grain than both the clone's own interior and the untouched
   surroundings on either side of it — a distinct, flatter-looking ring
   that reads as "this is obviously a separate patch" even when the
   underlying color is correct. This was the actual shape of a reported
   "areola": not a wrong color so much as a wrong TEXTURE, worst exactly
   at the boundary where two grain fields got mixed. Fixed in the final
   write loop (applyStrokeToBuffer) by ditherThreshold: instead of every
   pixel in the ring taking a fractional blend, each pixel commits fully
   to clone OR original, chosen by a fixed per-pixel hash against the
   geometric alpha at that point. Over the whole ring this reproduces
   the exact same 0→1 falloff curve (half the ring's pixels are
   full-clone right where alpha≈0.5) — but every individual OUTPUT pixel
   keeps its own side's full, un-averaged grain, so nothing gets visibly
   flattened. Stroke opacity (the user-chosen "how fully the clone
   replaces the original", constant across the whole stroke) is
   deliberately NOT dithered — it doesn't vary across the disk's own
   geometry, so it isn't a source of a ring-shaped artifact, and a user
   who picked partial opacity is asking for an actual blend.

   NEAREST-NEIGHBOR pixel copy, not bilinear: the disk's own INTERIOR
   used to read measurably softer than untouched surroundings, because
   the actual pixel copy sampled the source with sampleBilinear at
   (x+dx, y+dy) — and a real drag's offset is essentially never an exact
   integer, so nearly every copied pixel was actually a weighted average
   of 2-4 neighboring source pixels. On real photographic grain that's
   not subtle: tested with a realistic fractional offset against a
   uniformly-grainy synthetic scene, the disk interior's own variance
   dropped to ~28% of the surrounding grain's natural level. Reported by
   the user as a "frame" outlining the clone even with color and the
   feather ring (see feedback_stamp_dithered_feather.md) both already
   fixed — a heavily blurred patch is still visibly a separate patch
   against sharp surroundings, independent of tone or ring blending.
   Fixed by giving the pixel-copy step its own function, sampleNearest —
   no averaging, the literal closest source pixel — while the SEPARATE
   area-context sampling (areaMedian/destContext, used only to compute
   corrections, never to produce output pixels) keeps using
   sampleBilinear, where smoothing is actually appropriate. The trade-off
   is the copied content can sit up to half a source pixel off a
   perfectly continuous sub-pixel position; for photographic grain (no
   hard geometric edges to alias against) that's not visible, unlike it
   would be for vector art or a hard-edged synthetic pattern.

   Known simplification, flagged not hidden: the angular resolution for
   color match is still coarse (12 directions), and there's still no
   true gradient/edge-continuity synthesis the way Poisson blending or
   Mean-Value Coordinates would provide. Acceptable for the common case
   (dust spots, hairs, small distractions, patches against a
   differently-colored or differently-grained neighboring feature); a
   candidate for a future upgrade otherwise.

   Coordinate space: stroke geometry (points[].x/y, radius, dx, dy)
   is always in *caller-supplied buffer* pixel units — callers scale
   from the stored original-image-pixel coordinates into whatever
   resolution they're baking at before calling these functions,
   exactly like bakePreview already does for qcx/qcy via its own
   proxy-scale factor. Per-point color offsets are deliberately never
   cached/persisted anywhere — they're recomputed fresh from whatever
   buffer is actually being baked, every single time.

   Strokes are always replayed in array order against the buffer
   they're given, mutating it as they go — so a later stroke's source
   legitimately picks up an earlier stroke's result when the two
   overlap (stack cloned-over pixels the same way a real clone stamp
   tool would). GLImage relies on exactly this: it recomposites the
   *entire* current stroke list from a pristine decode on every
   change, rather than rendering each stroke independently, so the
   live preview can never show a stroke sourcing from since-edited
   pixels as if they were still untouched.
   ============================================================ */

const DEFAULT_FEATHER = 0.3;      // default feather zone width, as a fraction of radius
const DEFAULT_OPACITY = 1;        // default strength — 1 = fully replace, less = blend with the original
const COLOR_OFFSET_CAP = 40;      // max |per-channel correction| — see areaMedian below
const DEST_ANGULAR_BINS = 12;     // ~30° angular resolution for directional dest color match — see destContext below
const DEVIATION_CAP = 40;         // max |per-channel deviation from the flat offset| any single direction can pull toward
const BIN_SPREAD_LOW = 18;        // per-bin max-min spread below which that bin is fully trusted (consistent local texture)
const BIN_SPREAD_HIGH = 45;       // per-bin spread above which that bin is fully distrusted (it's straddling a real edge, not just texture noise) — see destContext's confidence note
const BIN_MEAN_DIST_LOW = 35;     // a bin within this distance of the pooled median reads as plausible gradual variation, fully trusted
const BIN_MEAN_DIST_HIGH = 70;    // a bin farther than this is very likely an unrelated surface entirely (not a directional gradient of the same one), fully distrusted regardless of its own internal consistency
const DEST_DIRECTIONAL_MAX_BAND = 1.6; // angular bins only use DEST_AREA_BANDS entries up to this — a genuine gradient (not just noise) sampled as far out as 2.5x radius describes the ring's far field, not what's actually adjacent to the disk boundary; the flat pooled `mean` still uses every band
const CONTAM_DIST = 55;           // a pooled ring sample farther than this from the ring's own median is a genuinely different surface (e.g. a lip), not texture noise
const CONTAM_FRAC_LOW = 0.12;     // below this fraction of contaminated samples, the flat correction is fully trusted as-is
const CONTAM_FRAC_HIGH = 0.4;     // at/above this fraction, the flat correction (and everything derived from it) is fully suppressed — see destContext's meanConfidence note
const TWO_PI = Math.PI * 2;

export function isEmptyStamp(stamp) {
  return !stamp || stamp.length === 0;
}

/* Back-compat migration: photos edited before strokes existed (or before
   the "heal" -> "clone stamp" rename) have `stamp`/`heal` entries in the
   old single-circle shape ({dstX,dstY,srcX,srcY,radius}). Every entry
   point that reads stored stamp/heal edits (this module, and App.jsx's
   mapStampStrokes/Editor state init) runs it through this first, so old
   edits keep working — and re-saving them (any further stamp edit
   auto-commits the whole array) upgrades them to the new shape for good.
   Already-new-shape entries pass through untouched; anything unrecognized
   is dropped rather than crashing the pipeline. */
export function normalizeStamp(stamp) {
  if (!stamp) return [];
  const out = [];
  for (const entry of stamp) {
    if (entry && Array.isArray(entry.points) && entry.points.length && entry.radius > 0) {
      out.push({
        ...entry,
        feather: entry.feather > 0 ? entry.feather : DEFAULT_FEATHER,
        opacity: entry.opacity > 0 ? entry.opacity : DEFAULT_OPACITY,
      });
    } else if (entry && entry.dstX !== undefined && entry.srcX !== undefined && entry.radius > 0) {
      out.push({
        points: [{ x: entry.dstX, y: entry.dstY }],
        radius: entry.radius,
        dx: entry.srcX - entry.dstX,
        dy: entry.srcY - entry.dstY,
        feather: DEFAULT_FEATHER,
        opacity: DEFAULT_OPACITY,
      });
    }
  }
  return out;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/* Nearest-neighbor sample at fractional (x, y) — no interpolation, just
   the single closest source pixel, exactly as stored. Used ONLY for the
   actual pixel COPY in applyStrokeToBuffer's write loop (see its call
   site), never for the area-context sampling above (areaMedian/
   destContext genuinely want a smoothed read there — they're measuring
   a general surrounding tone, not reproducing detail). A real drag's
   source offset (dx, dy) is essentially never an exact integer, so every
   copied pixel used to go through sampleBilinear at a fractional
   coordinate — averaging 2-4 neighboring source pixels together. On real
   photographic grain that measurably destroys detail: tested against a
   uniformly-grainy synthetic scene with a realistic fractional offset,
   the cloned disk's own INTERIOR variance dropped to ~28% of the
   surrounding grain's natural level — a heavily blurred patch dropped
   onto sharp, untouched skin, which is exactly what reads as a visible
   "frame" outlining the clone even once color and the feather ring are
   both well matched (see feedback_stamp_dithered_feather.md — that fix
   covered the RING's variance loss from cross-fading, not this, the
   INTERIOR's own variance loss from resampling). Nearest-neighbor is a
   literal, un-averaged copy — the "just copy 1:1" behavior asked for
   directly — at the cost of the copied content potentially sitting up
   to half a source pixel off from a perfectly continuous sub-pixel
   position; for photographic grain (no hard geometric edges to alias
   against) that's imperceptible, unlike it would be for vector art. */
function sampleNearest(buf, width, height, channels, x, y) {
  const cx = Math.min(Math.max(Math.round(x), 0), width - 1);
  const cy = Math.min(Math.max(Math.round(y), 0), height - 1);
  const o = (cy * width + cx) * channels;
  return [buf[o], buf[o + 1], buf[o + 2]];
}

/* Bilinear-sample buf at fractional (x, y). Out-of-bounds coordinates
   are clamped to the nearest edge pixel (CLAMP_TO_EDGE, matching the
   GPU texture's own wrap mode). Returns [r, g, b]. Works identically on
   the real image buffer (channels=3 or 4) and on the small local RGB
   snapshot applyStrokeToBuffer copies out before painting (channels=3).
   Used for area-context sampling (areaMedian/destContext) — deliberately
   NOT used for the final pixel copy itself, see sampleNearest above. */
function sampleBilinear(buf, width, height, channels, x, y) {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0, fy = cy - y0;
  const o00 = (y0 * width + x0) * channels;
  const o10 = (y0 * width + x1) * channels;
  const o01 = (y1 * width + x0) * channels;
  const o11 = (y1 * width + x1) * channels;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = buf[o00 + c] * (1 - fx) + buf[o10 + c] * fx;
    const bot = buf[o01 + c] * (1 - fx) + buf[o11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* Per-channel MEDIAN (not mean) of `bands` worth of concentric-circle
   samples around (cx, cy), read from buf as it stands *before* any clone
   copy is applied. Points that land outside the buffer are skipped
   (edge-of-photo points). `bands` defaults to AREA_BANDS (SOURCE side,
   mostly disk interior); the destination side passes DEST_AREA_BANDS
   instead (see this module's header for why they need to differ).

   Median, not mean: for an elongated defect (a wire, a hair, a thin pole)
   whose own width is well inside one point's radius but whose LENGTH is
   not, a sample can re-cross the same defect further up/down its own
   path — e.g. a point centered on a straight vertical pole has samples
   directly above and below it that land back ON the pole, not on the
   surrounding sky. A mean lets that handful of contaminated samples
   visibly drag the color match toward the defect's own color, leaving a
   faint ghost of it behind after the "clean" clone; a median just needs
   the (unaffected) majority of the samples to still be background,
   which holds for any defect comfortably narrower than the point's own
   radius — exactly the recommended way to size this brush in the first
   place.

   Mostly the DISK itself, not a thin ring outside it: an earlier version
   sampled only a thin ring just past the circle's boundary, reasoning
   that the ring shows "clean surroundings" while the disk interior might
   contain whatever's being removed. That fails on real, spatially-
   varying texture (sand, gravel, grass) — the ring is a DIFFERENT patch
   of ground from the disk itself, and can easily read a bit greener or
   pinker even though the disk's own actual content looks completely
   normal; the correction computed from it then gets applied across the
   WHOLE copied disk regardless. AREA_BANDS instead spans mostly the
   disk's own interior (0.2–0.95× radius) — several concentric bands with
   MORE samples on the outer, larger-circumference ones so the sample
   stays roughly even per unit area, i.e. genuinely representative of
   "the whole area being copied", matching how a person would actually
   judge whether two patches of ground look the same — plus one band
   just past the boundary (1.15×) purely so a real defect that fills
   most of the DESTINATION disk still gets out-voted by the surrounding
   clean context rather than treated as "the normal color here". */
const AREA_BANDS = [0.2, 0.4, 0.6, 0.8, 0.95, 1.15];

/* DESTINATION color-match sampling — a ring strictly OUTSIDE the disk
   (and its feather zone, which starts fading in the source at 1.0 and
   is fully the destination's original content by radius*(1+feather),
   i.e. up to ~1.3 for the DEFAULT_FEATHER=0.3 default, more for a wider
   feather) — see this module's header for why the destination must
   never sample its own disk interior. Multiple bands (not one thin
   ring), same robustness-to-texture reasoning AREA_BANDS was widened
   for on the source side. Starts at 1.3 rather than exactly 1.0 so it
   clears a typical feather zone instead of blending source and
   destination content in the same sample. */
const DEST_AREA_BANDS = [1.3, 1.6, 2.0, 2.5];

function areaMedian(buf, width, height, channels, cx, cy, radius, bands = AREA_BANDS) {
  const rs = [], gs = [], bs = [];
  for (const band of bands) {
    const r = radius * band;
    const n = Math.max(8, Math.round(24 * band)); // more samples on bigger (outer) bands — roughly even density per unit area
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + band; // phase-shift per band, avoids all bands sampling the same angles
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
      const [r0, g0, b0] = sampleBilinear(buf, width, height, channels, x, y);
      rs.push(r0); gs.push(g0); bs.push(b0);
    }
  }
  if (rs.length === 0) return [0, 0, 0];
  return [median(rs), median(gs), median(bs)];
}

function clampMag(v, cap) {
  return v < -cap ? -cap : v > cap ? cap : v;
}

function clampOffset(v) {
  return clampMag(v, COLOR_OFFSET_CAP);
}

/* DESTINATION-side sampling for directional color match: walks the exact
   same DEST_AREA_BANDS ring geometry areaMedian(..., DEST_AREA_BANDS)
   would, in one pass, but additionally buckets every sample into
   DEST_ANGULAR_BINS angular sectors around (cx, cy) — not just pooling
   everything into one median. Returns { mean, bins, confidence }: `mean`
   is the same whole-ring median the old flat design used (per-channel
   [r,g,b]); `bins` is an array of DEST_ANGULAR_BINS per-channel [r,g,b]
   medians, one per ~30° sector, index k covering angle
   [k*2π/K, (k+1)*2π/K). Bins only draw from DEST_AREA_BANDS entries up
   to DEST_DIRECTIONAL_MAX_BAND (the two innermost bands) even though
   `mean` pools every band: a real, gradual tone gradient (not just
   texture noise) sampled as far out as the outermost 2.5x-radius band
   describes the ring's FAR field, not what's actually adjacent to the
   disk's own boundary — using it directionally overshot past the true
   boundary-adjacent tone in testing. The flat `mean` still wants every
   band for its own, separate robustness reasons (see AREA_BANDS/
   DEST_AREA_BANDS above), unaffected by this.

   A bin with zero in-bounds samples (can happen near a photo edge, where
   ring points on one side fall off-buffer) inherits the nearest
   non-empty bin found by searching outward in both directions; if every
   bin is empty (whole ring off-buffer) all K entries fall back to
   `mean` (itself [0,0,0] in that degenerate case, same as areaMedian's
   own empty-sample fallback) — so a caller can always safely index
   bins[k] without a null check.

   `confidence[k]` (0..1) is how much that bin's directional pull should
   actually be trusted — the PRODUCT of two independent checks, either of
   which can veto it:

   - internal: how consistent that bin's own raw samples were with EACH
     OTHER (max−min spread per channel, before reducing to a median). A
     bin whose samples are all close together (gradual skin texture, a
     soft lighting gradient) scores ~1; a bin whose samples span a real
     material change (some landed on skin, some crossed onto a lip, a
     hair, a hard shadow edge) — i.e. STRADDLING two surfaces — has high
     internal spread and scores near 0.
   - external: how close that bin's resulting median is to the pooled
     `mean` (the same whole-ring anchor the flat correction itself uses).
     This catches the case internal spread CAN'T: a bin sitting ENTIRELY
     inside a different surface (wholly within the lip, not straddling
     its edge) has perfectly consistent samples that all agree with each
     other — internal alone would score it ~1 — but the value they agree
     on is simply the wrong surface's color, not a gradual variation of
     the right one. A bin far from the overall pooled anchor scores near
     0 here regardless of how internally tidy it is.

   Both checks were needed, found in that order, on the same synthetic
   "disk cloned close under a lip" scene: the internal-only version
   still let a bin sitting fully inside the lip compute a confident,
   consistent, and confidently-WRONG median, which got applied
   directionally and came out as a visible magenta/purple tint across
   the disk — reported by the user as "just copy 1:1, why does the
   copied zone look nothing like either side" (an even worse, more
   obviously-broken artifact than the flat halo this feature exists to
   fix in the first place). Confidence is what keeps directional
   matching to "lean toward the real gradual variation nearby" and out
   of "hallucinate a nearby hard edge's color into the clone," from
   either direction of failure. A bin filled in from a neighbor (no real
   samples of its own) gets confidence 0 outright — it has no actual
   local evidence, so it must defer entirely to the flat mean.

   `meanConfidence` (0..1) is the SAME kind of guard, one level up: the
   per-bin `confidence` above only protects the DIRECTIONAL deviation —
   the flat `mean` itself (used at the disk's own center, and as every
   bin's fallback) was still an unguarded median over the WHOLE pooled
   ring, all 4 DEST_AREA_BANDS out to 2.5x radius. Cloning close enough
   under a lip that a large arc of that ring — not just one bin's worth —
   falls on the lip itself lets even the median get dragged toward it
   (a median only resists a MINORITY of contamination; a real photo can
   have close to half the ring on the wrong surface), and that shows up
   as the flat correction pulling the WHOLE disk toward an obviously
   wrong color (reported as a magenta/purple tint on a skin clone — not
   a subtle ring, an unmistakably wrong flat fill). `meanConfidence`
   counts what fraction of the pooled samples sit farther than
   CONTAM_DIST from the ring's own median color — a plausible defect or
   gradual texture keeps that fraction low; a ring genuinely straddling
   two different surfaces (skin vs. lip) does not. Below CONTAM_FRAC_LOW
   the flat correction is fully trusted (unchanged from before); at/above
   CONTAM_FRAC_HIGH it's suppressed to exactly 0, which — since every
   directional deviation is computed relative to this same flat value —
   collapses the ENTIRE correction to nothing: the clone becomes a
   literal, uncorrected 1:1 copy of the source pixels. That fallback is
   deliberate, not a bug being tolerated: when the destination context is
   too inconsistent to trust ANY single representative color for it,
   guessing is worse than not correcting at all. */
function destContext(buf, width, height, channels, cx, cy, radius) {
  const K = DEST_ANGULAR_BINS;
  const binR = Array.from({ length: K }, () => []);
  const binG = Array.from({ length: K }, () => []);
  const binB = Array.from({ length: K }, () => []);
  const allR = [], allG = [], allB = [];
  for (const band of DEST_AREA_BANDS) {
    const r = radius * band;
    const n = Math.max(8, Math.round(24 * band));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + band;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) continue;
      const [r0, g0, b0] = sampleBilinear(buf, width, height, channels, x, y);
      allR.push(r0); allG.push(g0); allB.push(b0);
      if (band > DEST_DIRECTIONAL_MAX_BAND) continue; // pooled mean uses this sample; angular bins don't — see DEST_DIRECTIONAL_MAX_BAND
      const norm = ((a % TWO_PI) + TWO_PI) % TWO_PI;
      const k = Math.min(K - 1, Math.floor((norm / TWO_PI) * K));
      binR[k].push(r0); binG[k].push(g0); binB[k].push(b0);
    }
  }
  const mean = allR.length ? [median(allR), median(allG), median(allB)] : [0, 0, 0];
  let contaminated = 0;
  for (let i = 0; i < allR.length; i++) {
    const d = Math.hypot(allR[i] - mean[0], allG[i] - mean[1], allB[i] - mean[2]);
    if (d > CONTAM_DIST) contaminated++;
  }
  const contamFrac = allR.length ? contaminated / allR.length : 0;
  const meanConfidence = 1 - smoothstep(CONTAM_FRAC_LOW, CONTAM_FRAC_HIGH, contamFrac);
  const bins = new Array(K);
  const confidence = new Array(K).fill(0);
  for (let k = 0; k < K; k++) {
    if (!binR[k].length) { bins[k] = null; continue; }
    bins[k] = [median(binR[k]), median(binG[k]), median(binB[k])];
    const spread = Math.max(
      Math.max(...binR[k]) - Math.min(...binR[k]),
      Math.max(...binG[k]) - Math.min(...binG[k]),
      Math.max(...binB[k]) - Math.min(...binB[k]),
    );
    const internalConfidence = 1 - smoothstep(BIN_SPREAD_LOW, BIN_SPREAD_HIGH, spread);
    // a bin sitting ENTIRELY inside a different surface (wholly within the
    // lip, not straddling its edge) has low internal spread — all its own
    // samples agree with EACH OTHER — so internalConfidence alone rates it
    // fully trustworthy, even though the value it agrees on has nothing to
    // do with the surrounding skin. Caught a real bug this way: a disk
    // cloned close under a lip came out visibly magenta-tinted even with
    // per-bin spread already guarded, because whole bins fell entirely
    // inside the lip. distFromMean checks the bin's color against the
    // POOLED median (the same anchor the flat correction itself uses) —
    // a genuine gradual directional variation (warmer near the mouth)
    // stays close to that anchor; an unrelated surface entirely doesn't.
    const distFromMean = Math.hypot(bins[k][0] - mean[0], bins[k][1] - mean[1], bins[k][2] - mean[2]);
    const externalConfidence = 1 - smoothstep(BIN_MEAN_DIST_LOW, BIN_MEAN_DIST_HIGH, distFromMean);
    confidence[k] = internalConfidence * externalConfidence;
  }
  for (let k = 0; k < K; k++) {
    if (bins[k]) continue;
    let filled = mean;
    for (let d = 1; d < K; d++) {
      const kp = bins[(k + d) % K], km = bins[(k - d + K) % K];
      if (kp) { filled = kp; break; }
      if (km) { filled = km; break; }
    }
    bins[k] = filled; // confidence[k] stays 0 — no real samples of its own
  }
  return { mean, bins, confidence, meanConfidence };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* Deterministic, well-distributed pseudo-random value in [0,1) for an
   integer pixel coordinate — a standard 32-bit hash-mix, the same shape
   as the "stochastic/dithered alpha" technique GPU shaders use to avoid
   banding. Same (x,y) always gives the same value (stable across
   re-renders of the same stroke, no temporal flicker/shimmer), and
   neighboring pixels land far apart in the output range (no visible
   large-scale pattern within the dithered feather ring — see its call
   site in applyStrokeToBuffer). */
function ditherThreshold(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/* Closest point to (px,py) on the segment a→b, plus the projection
   parameter t (0 at a, 1 at b) used to interpolate per-endpoint data
   (offset, color match) smoothly along the segment. Degenerates cleanly
   to "distance to a" when a===b (a one-point stroke's single "segment"). */
function closestOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: ax + abx * t, y: ay + aby * t, t };
}

/* Composites one stroke — its whole polyline as a single smooth capsule —
   onto buf in place. `stroke` = { points:[{x,y,dx?,dy?}], radius, dx, dy,
   feather, opacity } (already normalized).

   Two passes, at whole-stroke granularity: the first only READS from buf
   (copies the region this stroke could possibly read from into a small
   local snapshot, and computes each polyline point's own color-match
   offset against that snapshot); the second only WRITES, blending each
   destination pixel exactly once against whichever polyline segment is
   closest to it. This is the same read-then-write hazard a single
   overlapping dab always guarded against (see the module header),
   generalized from "one dab" to "one whole stroke" — without it, a
   segment could read pixels an earlier segment of the SAME stroke had
   already repainted a moment before, or recompute a color-match ring
   against partially-corrected pixels.

   "Blended exactly once" also means the covered region is tracked in a
   Map keyed by pixel offset rather than a dense array sized to the
   stroke's full bounding box — a long, spread-out stroke (say, a wire
   traced corner-to-corner) would otherwise force allocating (and
   scanning) an array covering its entire bounding box even though the
   pixels actually near its path are a small fraction of that area. The
   Map only ever holds entries for pixels within `radius*(1+feather)` of
   some segment, i.e. proportional to the stroke's own length, same as
   the old per-dab approach's total footprint. */
function applyStrokeToBuffer(buf, width, height, channels, stroke) {
  const radius = stroke.radius;
  const pts = stroke.points;
  if (!(radius > 0) || !pts || !pts.length) return;
  const feather = stroke.feather > 0 ? stroke.feather : DEFAULT_FEATHER;
  const opacity = stroke.opacity > 0 ? Math.min(1, stroke.opacity) : DEFAULT_OPACITY;
  const outer = radius * (1 + feather);
  const dxs = pts.map((p) => (p.dx ?? stroke.dx));
  const dys = pts.map((p) => (p.dy ?? stroke.dy));

  const readMargin = Math.max(outer, radius * AREA_BANDS[AREA_BANDS.length - 1], radius * DEST_AREA_BANDS[DEST_AREA_BANDS.length - 1]) + 2;
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const sx = pts[i].x + dxs[i], sy = pts[i].y + dys[i];
    rx0 = Math.min(rx0, pts[i].x - readMargin, sx - readMargin);
    ry0 = Math.min(ry0, pts[i].y - readMargin, sy - readMargin);
    rx1 = Math.max(rx1, pts[i].x + readMargin, sx + readMargin);
    ry1 = Math.max(ry1, pts[i].y + readMargin, sy + readMargin);
  }
  rx0 = Math.max(0, Math.floor(rx0)); ry0 = Math.max(0, Math.floor(ry0));
  rx1 = Math.min(width - 1, Math.ceil(rx1)); ry1 = Math.min(height - 1, Math.ceil(ry1));
  // whole read footprint falls off-buffer (e.g. a stroke that's off-frame
  // in a cropped preview, or outside a deep-zoom tile's crop window) —
  // bail before allocating the snapshot below.
  if (rx1 < rx0 || ry1 < ry0) return;
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const snap = new Float32Array(rw * rh * 3);
  for (let y = 0; y < rh; y++) {
    const srcRow = (y + ry0) * width;
    for (let x = 0; x < rw; x++) {
      const o = (srcRow + x + rx0) * channels;
      const so = (y * rw + x) * 3;
      snap[so] = buf[o]; snap[so + 1] = buf[o + 1]; snap[so + 2] = buf[o + 2];
    }
  }

  // clamped: the area match is meant to smooth over a SUBTLE tone
  // difference (soft shadow, slight lighting drift) — a much larger
  // computed offset is more likely a noisy read (see areaMedian's own
  // note on fine texture) than a real one, and left uncapped it's exactly
  // what turned into a visible dark or tinted patch instead of a clean
  // blend.
  //
  // drRaw/dgRaw/dbRaw is the flat whole-ring correction (used at the
  // disk's own center, and as the fallback anchor everywhere); devR/
  // devG/devB are the per-angular-bin DEVIATION from that flat value
  // (see destContext and the module header's "DIRECTIONAL color match"
  // section) — how much this one direction's true surroundings differ
  // from the overall average, applied with growing weight toward the
  // disk's boundary so a clone next to an asymmetric edge (a lip, a
  // hard shadow line) blends toward what's actually adjacent on each
  // side instead of one flat average that can only ever match one side.
  // Both the raw flat value AND every deviation (computed relative to
  // it) get scaled by meanConfidence at the end — see destContext's own
  // note: when the destination ring itself is too internally
  // inconsistent to trust (straddling skin and lip, say), this collapses
  // the whole correction toward 0, i.e. a literal, uncorrected 1:1 copy.
  const offsets = pts.map((p, i) => {
    // destination: ring OUTSIDE the disk (DEST_AREA_BANDS) — never the
    // disk's own interior, which is exactly the content being replaced.
    const dest = destContext(snap, rw, rh, 3, p.x - rx0, p.y - ry0, radius);
    // source: the disk itself (default AREA_BANDS) — this IS the content being copied.
    const [sr, sg, sb] = areaMedian(snap, rw, rh, 3, p.x + dxs[i] - rx0, p.y + dys[i] - ry0, radius);
    const drRaw = clampOffset(dest.mean[0] - sr), dgRaw = clampOffset(dest.mean[1] - sg), dbRaw = clampOffset(dest.mean[2] - sb);
    const devR = new Float32Array(DEST_ANGULAR_BINS);
    const devG = new Float32Array(DEST_ANGULAR_BINS);
    const devB = new Float32Array(DEST_ANGULAR_BINS);
    const mc = dest.meanConfidence;
    for (let k = 0; k < DEST_ANGULAR_BINS; k++) {
      const conf = dest.confidence[k];
      devR[k] = clampMag((clampOffset(dest.bins[k][0] - sr) - drRaw) * conf * mc, DEVIATION_CAP);
      devG[k] = clampMag((clampOffset(dest.bins[k][1] - sg) - dgRaw) * conf * mc, DEVIATION_CAP);
      devB[k] = clampMag((clampOffset(dest.bins[k][2] - sb) - dbRaw) * conf * mc, DEVIATION_CAP);
    }
    return { dr: drRaw * mc, dg: dgRaw * mc, db: dbRaw * mc, devR, devG, devB };
  });

  // segments = consecutive point pairs; a single-point stroke gets one
  // degenerate (zero-length) segment so the exact same math applies.
  const segCount = pts.length > 1 ? pts.length - 1 : 1;
  const best = new Map();
  for (let s = 0; s < segCount; s++) {
    const i0 = s, i1 = pts.length > 1 ? s + 1 : 0;
    const ax = pts[i0].x, ay = pts[i0].y, bx = pts[i1].x, by = pts[i1].y;
    const sx0 = Math.max(0, Math.floor(Math.min(ax, bx) - outer));
    const sx1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + outer));
    const sy0 = Math.max(0, Math.floor(Math.min(ay, by) - outer));
    const sy1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + outer));
    if (sx1 < sx0 || sy1 < sy0) continue;
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        const c = closestOnSegment(x, y, ax, ay, bx, by);
        const dist = Math.hypot(x - c.x, y - c.y);
        if (dist > outer) continue;
        const key = y * width + x;
        const prev = best.get(key);
        if (prev && prev.dist <= dist) continue;
        const t = c.t;
        const o0 = offsets[i0], o1 = offsets[i1];
        // this pixel's angle around the nearest point on the stroke's own
        // polyline — at dist=0 (dead center) atan2(0,0) is arbitrary, but
        // radialWeight is 0 there too, so it never actually matters which
        // angle gets picked.
        const angle = Math.atan2(y - c.y, x - c.x);
        const norm = ((angle % TWO_PI) + TWO_PI) % TWO_PI;
        const kf = (norm / TWO_PI) * DEST_ANGULAR_BINS;
        const k0 = Math.floor(kf) % DEST_ANGULAR_BINS;
        const k1 = (k0 + 1) % DEST_ANGULAR_BINS;
        const bf = kf - Math.floor(kf);
        const radialWeight = smoothstep(0, radius, dist);
        const devR = (o0.devR[k0] * (1 - bf) + o0.devR[k1] * bf) * (1 - t) + (o1.devR[k0] * (1 - bf) + o1.devR[k1] * bf) * t;
        const devG = (o0.devG[k0] * (1 - bf) + o0.devG[k1] * bf) * (1 - t) + (o1.devG[k0] * (1 - bf) + o1.devG[k1] * bf) * t;
        const devB = (o0.devB[k0] * (1 - bf) + o0.devB[k1] * bf) * (1 - t) + (o1.devB[k0] * (1 - bf) + o1.devB[k1] * bf) * t;
        best.set(key, {
          dist,
          dx: dxs[i0] + (dxs[i1] - dxs[i0]) * t,
          dy: dys[i0] + (dys[i1] - dys[i0]) * t,
          dr: o0.dr + (o1.dr - o0.dr) * t + devR * radialWeight,
          dg: o0.dg + (o1.dg - o0.dg) * t + devG * radialWeight,
          db: o0.db + (o1.db - o0.db) * t + devB * radialWeight,
        });
      }
    }
  }

  for (const [key, v] of best) {
    const alphaGeom = 1 - smoothstep(radius, outer, v.dist);
    if (alphaGeom <= 0) continue;
    const x = key % width, y = (key - x) / width;
    // DITHERED feather, not a continuous cross-fade: a pixel at, say,
    // alphaGeom=0.5 does NOT get 50% clone + 50% original blended into
    // one averaged value — it commits fully to one side or the other,
    // chosen by ditherThreshold (a fixed per-pixel hash, so the choice
    // never flickers between renders of the same stroke). Across the
    // whole feather ring this reproduces the exact same 0->1 gradient
    // rawGeom describes (half the ring's pixels are full-clone, half are
    // full-original, right where alphaGeom≈0.5) — but every individual
    // OUTPUT pixel keeps its own side's full, un-averaged grain. See the
    // module header's "DIRECTIONAL color match" section for why this
    // exists: continuous cross-fading averages two INDEPENDENT noise
    // fields (the clone's and the original's own photographic grain),
    // and averaging independent noise reduces its variance — visibly
    // flattening texture in exactly the ring-shaped zone where
    // alphaGeom is neither 0 nor 1, which is what actually reads as a
    // distinct "sticker" outline, even when color match is otherwise
    // good. opacity (a stroke-wide, user-chosen constant — "how fully
    // the clone replaces the original") stays a genuine continuous
    // multiply on top, deliberately NOT dithered: it's not what varies
    // across the disk's own geometry, so it isn't a source of a ring-
    // shaped artifact, and a user who chose partial opacity is asking
    // for an actual blend, not a stochastic one.
    const dithered = alphaGeom >= 1 ? 1 : ditherThreshold(x, y) < alphaGeom ? 1 : 0;
    const alpha = dithered * opacity;
    if (alpha <= 0) continue;
    const [sr, sg, sb] = sampleNearest(snap, rw, rh, 3, x + v.dx - rx0, y + v.dy - ry0);
    const o = key * channels;
    buf[o] = buf[o] * (1 - alpha) + clamp255(sr + v.dr) * alpha;
    buf[o + 1] = buf[o + 1] * (1 - alpha) + clamp255(sg + v.dg) * alpha;
    buf[o + 2] = buf[o + 2] * (1 - alpha) + clamp255(sb + v.db) * alpha;
  }
}

/* Mutates buf in place (a Node Buffer or a Uint8ClampedArray alike) and
   returns it. `stamp` is an array of strokes (see header); strokes are
   composited in array order, so a later stroke's source/blend can
   legitimately read pixels an earlier stroke in the same call already
   modified (matches stacking clone-stamp edits in Photoshop). No-ops
   when isEmptyStamp(stamp). */
export function applyStampToRGBBuffer(buf, width, height, channels, stamp) {
  if (isEmptyStamp(stamp)) return buf;
  for (const stroke of normalizeStamp(stamp)) {
    applyStrokeToBuffer(buf, width, height, channels, stroke);
  }
  return buf;
}
