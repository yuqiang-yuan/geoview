/**
 * geoview - Function sampler.
 *
 * Evaluates GeoGebra function expressions using mathjs and produces
 * polyline segments, splitting at discontinuities (asymptotes, jumps,
 * NaN/Infinity).
 *
 * GeoGebra expressions look like "f(x) = sin(x)" - the expression to
 * the right of "=" is extracted and compiled with mathjs.
 *
 * Angle unit: GGB stores angleUnit in kernel settings. When "degree",
 * trig functions in the expression expect degrees. mathjs uses radians
 * by default, so we wrap degree-mode evaluation with appropriate conversion.
 */

import { compile as mathCompile, type EvalFunction } from "mathjs";
import type { PolylineSegment, SampleResult, SamplerFn, SamplerParams } from "./render-types";

/**
 * Strip the "f(x) = " prefix from a GeoGebra expression string,
 * returning just the right-hand side (e.g. "sin(x)").
 */
export function extractExpression(exp: string): string {
    const eqIdx = exp.indexOf("=");
    if (eqIdx === -1) return exp.trim();
    return exp.slice(eqIdx + 1).trim();
}

/**
 * Split "If[a, b, c, d, ...]" argument text on top-level commas,
 * respecting bracket nesting and string literals.
 */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) {
                i++; // skip escaped char
            } else if (ch === "\"") {
                inString = false;
            }
            continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "," && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts.map((p) => p.trim());
}

/**
 * Break a chained comparison like "0 <= x <= 1.2" (which mathjs rejects)
 * into "(0 <= x) && (x <= 1.2)".
 */
function unchainComparison(cond: string): string {
    const parts = cond.split(/\s*(<=|>=|<|>|==|!=)\s*/);
    // Split with a capture group yields [operand, op, operand, op, ...]:
    // 2n+1 parts for n comparison operators; only unchain when n > 1
    if (parts.length <= 3 || parts.length % 2 === 0) return cond;
    const operands = parts.filter((_, i) => i % 2 === 0);
    const ops = parts.filter((_, i) => i % 2 === 1);
    const clauses: string[] = [];
    for (let i = 0; i < ops.length; i++) {
        clauses.push(`(${operands[i]} ${ops[i]} ${operands[i + 1]})`);
    }
    return clauses.join(" and ");
}

/**
 * Translate GeoGebra-specific syntax to mathjs:
 * - Unicode operators: <=, >=, !=, "and", "or"
 * - If[c1, v1, c2, v2, ..., default] (conditional/piecewise function)
 *   to nested ternaries, with chained comparisons unchained
 *
 * `If` args alternate condition/value with an optional trailing default;
 * a missing default becomes NaN (curve gap), matching GeoGebra's
 * undefined-outside-the-conditions behaviour.
 */
export function ggbToMathJs(expr: string): string {
    let s = expr
        .replace(/≤/g, "<=")
        .replace(/≥/g, ">=")
        .replace(/≠/g, "!=")
        .replace(/∧/g, " and ")
        .replace(/∨/g, " or ");

    // Recursively rewrite If[...] calls (inside-out via repeated rewriting)
    while (true) {
        const m = /If\s*\[/i.exec(s);
        if (!m) break;
        const open = m.index + m[0].length - 1; // index of "["
        let depth = 0;
        let close = -1;
        for (let i = open; i < s.length; i++) {
            if (s[i] === "[") depth++;
            else if (s[i] === "]") {
                depth--;
                if (depth === 0) {
                    close = i;
                    break;
                }
            }
        }
        if (close === -1) break; // unbalanced - leave as-is (compile fails safely)

        const args = splitTopLevel(s.slice(open + 1, close)).map(ggbToMathJs);

        if (args.length < 2) {
            // Degenerate If - just the value or NaN
            s = s.slice(0, m.index) + (args[0] ?? "NaN") + s.slice(close + 1);
            continue;
        }

        const hasDefault = args.length % 2 === 1;
        const valueCount = hasDefault ? args.length - 1 : args.length;
        let acc = hasDefault ? args[args.length - 1] : "NaN";
        for (let i = valueCount - 2; i >= 0; i -= 2) {
            // args[i] = condition, args[i+1] = value
            const cond = unchainComparison(args[i]);
            acc = `(${cond} ? ${args[i + 1]} : ${acc})`;
        }
        s = s.slice(0, m.index) + acc + s.slice(close + 1);
    }

    return s;
}

/**
 * Compile a GeoGebra expression into an evaluatable function.
 *
 * Note: GeoGebra's `angleUnit` setting affects angle-typed objects (e.g. 45°)
 * but NOT function expressions like `sin(x)`. In GeoGebra, `sin(x)` always
 * treats `x` as radians. We therefore pass `x` directly to mathjs without
 * degree->radian conversion.
 *
 * @param expression  raw GGB expression (e.g. "f(x) = sin(x)")
 * @param angleUnit    "degree" or "radian" (unused for function expressions,
 *                     reserved for future angle-object support)
 * @returns function that takes x and returns y, or NaN if undefined
 */
export function compileExpression(
    expression: string,
    angleUnit: "degree" | "radian" = "radian"
): (x: number) => number {
    const rhs = ggbToMathJs(extractExpression(expression));
    let compiled: EvalFunction;

    try {
        compiled = mathCompile(rhs);
    } catch {
        // If compilation fails, return a function that always yields NaN
        return () => NaN;
    }

    return (x: number): number => {
        try {
            const result = compiled.evaluate({ x });
            if (typeof result === "number") {
                return result;
            }
            // mathjs may return a Complex or Unit - extract numeric value
            if (result && typeof result.valueOf === "function") {
                const v = result.valueOf();
                if (typeof v === "number") return v;
            }
            return NaN;
        } catch {
            return NaN;
        }
    };
}

// ============================================================
// Pixel-space adaptive sampling & discontinuity detection
//
// All thresholds are measured in screen pixels, so behaviour is
// identical at any zoom level:
//
// 1. Base samples are taken every BASE_SPACING_PX pixels. A base
//    sample that yields NaN/Infinity is a hard break (the function
//    is undefined there); finite values outside the y reject margin
//    are dropped but do not force a break by themselves.
// 2. Each interval between kept base samples is either:
//    - "smooth" (pixel jump <= JUMP_FLAG_PX): refined geometrically
//      by bisection until the chord deviation is < FLATNESS_PX
//      (adaptive subdivision - sharp extrema get extra samples).
//      An undefined/out-of-range midpoint during refinement breaks
//      the segment (a pole hides inside the interval).
//    - "flagged" (bigger jump): classified by recursive bisection
//      ({@link classifyJump}), which reports one of:
//        connect     - steep/kinked but continuous (50x, abs(x))
//        split-keep  - bounded jump (floor, sign): split, keep endpoints
//        split-drop  - vertical asymptote (tan, 1/x): split, drop the
//                      inaccurate near-pole boundary points; the pole
//                      x position is reported for asymptote rendering
// ============================================================

/** Spacing between base samples, in pixels. */
const BASE_SPACING_PX = 2;
/** Intervals whose pixel-space |dy| exceeds this get classified. */
const JUMP_FLAG_PX = 2;
/** Midpoint within this pixel distance of the chord = locally straight. */
const FLATNESS_PX = 0.5;
/** A side of a break is "flat" if it varies less than this. */
const SIDE_FLAT_PX = 2;
/** How far (in pixels) outside a converged break to probe the sides. */
const SIDE_OFFSET_PX = 2;
/** Max bisection depth when classifying a suspected discontinuity. */
const MAX_CLASSIFY_DEPTH = 12;
/** Max bisection depth when geometrically refining a smooth interval. */
const MAX_REFINE_DEPTH = 10;
/** Base sample count bounds (keeps pan/zoom re-render cheap). */
const MIN_BASE_SAMPLES = 32;
const MAX_BASE_SAMPLES = 1024;
/** Assumed viewport width when pixel metrics are unknown. */
const FALLBACK_PIXEL_WIDTH = 800;
const FALLBACK_PIXEL_HEIGHT = 600;

/** Pixel-space scales and reject bounds for one sampling pass. */
interface PixelMetrics {
    /** Pixels per x unit */
    scaleXpx: number;
    /** Pixels per y unit */
    scaleYpx: number;
    /** Viewport height in pixels */
    pixelHeight: number;
    /** y values below this are rejected (viewport margin) */
    yRejectLo: number;
    /** y values above this are rejected (viewport margin) */
    yRejectHi: number;
}

/** Verdict for a suspected discontinuity between two samples. */
type Verdict = "connect" | "split-keep" | "split-drop";

/** Verdict plus break/asymptote positions for segment extension. */
interface JumpVerdict {
    verdict: Verdict;
    /** x of the break (for extending segments to the margin crossing) */
    breakX?: number;
    /** x position when the verdict is an asymptote-style split-drop */
    asymptoteX?: number;
}

/** A kept sample point; gapBefore records why preceding samples were dropped. */
interface SamplePoint {
    x: number;
    y: number;
    /** "undefined": NaN/Inf sample between this and the previous kept point */
    gapBefore?: "undefined";
    /** x of an undefined base sample in the gap (asymptote probing) */
    gapAt?: number;
}

/** Evaluate fn, returning a finite number or undefined. */
function evalFinite(fn: (x: number) => number, x: number): number | undefined {
    try {
        const y = fn(x);
        if (typeof y === "number" && !isNaN(y) && isFinite(y)) return y;
    } catch {
        // evaluation errors count as undefined points
    }
    return undefined;
}

/** y above the viewport margin? (unbounded growth => asymptote-like) */
function outOfRange(y: number, m: PixelMetrics): boolean {
    return y < m.yRejectLo || y > m.yRejectHi;
}

/**
 * Probe x0 from both sides at geometrically shrinking offsets and
 * report whether the function diverges past the reject margin with
 * opposite signs - the signature of a vertical asymptote (tan, 1/x).
 *
 * A fixed-offset probe fails when zoomed out: the margin grows with
 * the y range while the offset shrinks with the x scale, so the probe
 * must approach the pole until |f| exceeds the margin. Same-sign
 * divergence (1/x^2) or a bounded U-dip out of view returns false.
 */
function divergesAt(
    fn: (x: number) => number,
    x0: number,
    m: PixelMetrics
): boolean {
    const t0 = SIDE_OFFSET_PX / m.scaleXpx;
    for (let k = 0; k < 10; k++) {
        const t = t0 / Math.pow(2, k);
        const yL = evalFinite(fn, x0 - t);
        const yR = evalFinite(fn, x0 + t);
        const lBad = yL === undefined || outOfRange(yL, m);
        const rBad = yR === undefined || outOfRange(yR, m);
        if (lBad && rBad) {
            return yL === undefined || yR === undefined ||
                (yL > 0) !== (yR > 0);
        }
    }
    return false;
}

/**
 * Bisect between xIn (f in range) and xOut (f out of range/undefined)
 * to locate the margin-crossing x within sub-pixel accuracy. Returns
 * the in-range side of the interval, so the caller never emits a
 * point that is itself out of range.
 */
function marginBoundary(
    fn: (x: number) => number,
    xIn: number,
    xOut: number,
    m: PixelMetrics
): number {
    let lo = xIn;
    let hi = xOut;
    for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        const y = evalFinite(fn, mid);
        if (y !== undefined && !outOfRange(y, m)) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return lo;
}

/**
 * Whether f follows the chord from (a, ya) to (b, yb) within
 * FLATNESS_PX at the 1/4, 1/2 and 3/4 points. Three probes are used
 * because a single midpoint can coincidentally sit on the chord of a
 * pole-containing interval (e.g. tan(x) zoomed far out).
 */
function followsChord(
    fn: (x: number) => number,
    a: number,
    ya: number,
    b: number,
    yb: number,
    m: PixelMetrics
): boolean {
    const slope = (yb - ya) / (b - a);
    for (const t of [0.25, 0.5, 0.75]) {
        const x = a + (b - a) * t;
        const y = evalFinite(fn, x);
        if (y === undefined) return false;
        const chord = ya + slope * (x - a);
        if (Math.abs(y - chord) * m.scaleYpx > FLATNESS_PX) return false;
    }
    return true;
}

/**
 * Classify a converged (sub-pixel) interval [a, b] around a suspected
 * break by probing the function on either side of it.
 *
 * An out-of-range side probe alone is NOT an asymptote: a steep but
 * continuous curve legitimately exits the view margin. A vertical
 * asymptote requires the sides to diverge with opposite signs AND a
 * real jump across the break interval.
 */
function classifySides(
    fn: (x: number) => number,
    a: number,
    b: number,
    m: PixelMetrics
): JumpVerdict {
    const epsX = SIDE_OFFSET_PX / m.scaleXpx;
    const yL = evalFinite(fn, a - epsX);
    const yLa = evalFinite(fn, a);
    const yRb = evalFinite(fn, b);
    const yR = evalFinite(fn, b + epsX);

    // Undefined at or beside the break -> treat as a discontinuity,
    // dropping the inaccurate boundary points.
    if (yL === undefined || yLa === undefined ||
        yRb === undefined || yR === undefined) {
        return { verdict: "split-drop", breakX: (a + b) / 2 };
    }

    const breakJumpPx = Math.abs(yRb - yLa) * m.scaleYpx;
    const unboundedSide = outOfRange(yL, m) || outOfRange(yR, m);

    if (unboundedSide) {
        // Verified opposite-sign divergence + a real jump across the
        // break -> vertical asymptote (tan, 1/x).
        if (breakJumpPx > JUMP_FLAG_PX && divergesAt(fn, (a + b) / 2, m)) {
            const px = (a + b) / 2;
            return { verdict: "split-drop", breakX: px, asymptoteX: px };
        }
        // Otherwise this is a steep curve heading out of the view
        // margin (toward a pole handled by the pair that actually
        // spans it): connect, and let the geometric refinement break
        // at the margin exit, which keeps the curve accurate to the edge.
        return { verdict: "connect" };
    }

    // Both sides flat but at different values -> bounded jump (floor).
    const jumpPx = Math.abs(yR - yL) * m.scaleYpx;
    const flatL = Math.abs(yLa - yL) * m.scaleYpx < SIDE_FLAT_PX;
    const flatR = Math.abs(yRb - yR) * m.scaleYpx < SIDE_FLAT_PX;
    if (flatL && flatR && jumpPx > JUMP_FLAG_PX) {
        return { verdict: "split-keep" };
    }

    // Inconclusive at fixed pixel probes. When zoomed far out, the
    // converged interval can be far narrower than the probe offset,
    // hiding a whole pole neighbourhood (or a bounded jump) between
    // two in-range endpoints. Fall back to interval-relative probes:
    // constant sides -> bounded jump; an out-of-range interior -> a
    // pole, localized via the margin crossings on both sides.
    const d = (b - a) / 4;
    const yi = evalFinite(fn, a + d);
    const yj = evalFinite(fn, b - d);
    if (yi === undefined || yj === undefined) {
        return { verdict: "split-drop", breakX: (a + b) / 2 };
    }
    const flatInL = Math.abs(yi - yLa) * m.scaleYpx < SIDE_FLAT_PX;
    const flatInR = Math.abs(yj - yRb) * m.scaleYpx < SIDE_FLAT_PX;
    if (flatInL && flatInR && breakJumpPx > JUMP_FLAG_PX) {
        return { verdict: "split-keep" };
    }
    if (outOfRange(yi, m) || outOfRange(yj, m)) {
        const lb = marginBoundary(fn, a, b, m);
        const rb = marginBoundary(fn, b, a, m);
        const px = (lb + rb) / 2;
        return divergesAt(fn, px, m)
            ? { verdict: "split-drop", breakX: px, asymptoteX: px }
            : { verdict: "split-drop", breakX: px };
    }
    // Genuinely steep continuous stretch: the caller's geometric
    // refinement draws it accurately.
    return { verdict: "connect" };
}

/**
 * Classify a flagged interval (a, ya) -> (b, yb) by recursive bisection.
 *
 * Unlike geometric refinement, bisection continues while the pixel jump
 * persists at finer scales, so it converges toward wherever the jump
 * localizes. A midpoint that is undefined or beyond the reject margin
 * reveals a pole directly.
 */
function classifyJump(
    fn: (x: number) => number,
    a: number,
    ya: number,
    b: number,
    yb: number,
    m: PixelMetrics,
    depth: number
): JumpVerdict {
    const mid = (a + b) / 2;
    const ym = evalFinite(fn, mid);

    if (ym === undefined) {
        // Pole or hole exactly at the midpoint. Report an asymptote only
        // if the function diverges with opposite signs on both sides
        // (a removable hole like sin(x)/x at 0 must not draw a line).
        return divergesAt(fn, mid, m)
            ? { verdict: "split-drop", breakX: mid, asymptoteX: mid }
            : { verdict: "split-drop", breakX: mid };
    }

    // A near-pole midpoint diverges beyond the reject margin. Locate
    // the pole between the margin crossings on either side, then
    // verify divergence (a U-dip out of view must not report a line).
    if (outOfRange(ym, m)) {
        const lb = marginBoundary(fn, a, mid, m);
        const rb = marginBoundary(fn, b, mid, m);
        const px = (lb + rb) / 2;
        return divergesAt(fn, px, m)
            ? { verdict: "split-drop", breakX: px, asymptoteX: px }
            : { verdict: "split-drop", breakX: px };
    }

    if (depth <= 0) {
        // Depth exhausted: the interval is as narrow as bisection can
        // make it. Note the width can still dwarf a pole neighbourhood
        // when zoomed far out (1px is half a unit), which is why the
        // fixed-pixel side probes below have an interval-relative
        // fallback.
        return classifySides(fn, a, b, m);
    }

    // The interval is smooth at this scale (steep but straight) ->
    // continuous; the flag came from the overall slope.
    if (followsChord(fn, a, ya, b, yb, m)) {
        return { verdict: "connect" };
    }

    const left = classifyJump(fn, a, ya, mid, ym, m, depth - 1);
    if (left.verdict !== "connect") return left;
    const right = classifyJump(fn, mid, ym, b, yb, m, depth - 1);
    if (right.verdict !== "connect") return right;

    // Both halves are continuous. If the jump dissolved gradually the
    // function is smooth; if it persists across the midpoint boundary,
    // probe the sides to decide jump vs. steep kink.
    const jumpLM = Math.abs(ym - ya) * m.scaleYpx;
    const jumpMR = Math.abs(yb - ym) * m.scaleYpx;
    if (jumpLM <= JUMP_FLAG_PX && jumpMR <= JUMP_FLAG_PX) {
        return { verdict: "connect" };
    }
    return classifySides(fn, a, b, m);
}

/**
 * Bisect toward the y-transition between (x0, y0) and (x1, y1) to
 * locate a bounded jump within sub-pixel accuracy. Used to snap
 * segment endpoints of a split-keep to the actual jump position
 * (e.g. floor(x) jumps exactly at integers), independent of where
 * the base sampling grid happened to land.
 */
function locateJump(
    fn: (x: number) => number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    m: PixelMetrics
): number {
    let lo = x0;
    let hi = x1;
    for (let i = 0; i < 24 && (hi - lo) * m.scaleXpx > 0.1; i++) {
        const mid = (lo + hi) / 2;
        const y = evalFinite(fn, mid);
        if (y !== undefined && Math.abs(y - y0) <= Math.abs(y - y1)) {
            lo = mid; // still on the left value
        } else {
            hi = mid; // past the jump
        }
    }
    return (lo + hi) / 2;
}

/** Result of geometric refinement over one smooth interval. */
interface RefineResult {
    /** Points to append after the interval's left endpoint (includes b) */
    points: Array<{ x: number; y: number }>;
    /** True when a pole/undefined point was hit mid-interval */
    broke: boolean;
    /** Where the break occurred (the offending midpoint), if broke */
    breakX?: number;
}

/**
 * Geometrically refine the interval (a, ya) -> (b, yb) by bisection
 * until the chord deviation falls below FLATNESS_PX (adaptive
 * subdivision). Stops early with broke=true when a midpoint is
 * undefined or beyond the reject margin - a pole hides inside.
 */
function subdivide(
    fn: (x: number) => number,
    a: number,
    ya: number,
    b: number,
    yb: number,
    m: PixelMetrics,
    depth: number
): RefineResult {
    if (depth <= 0 || (b - a) * m.scaleXpx < 0.5) {
        // Sub-pixel terminal. A pole can still hide between two
        // in-range endpoints when zoomed out (e.g. tan next to a
        // pole: both sides are in range a few hundredths away), so
        // probe the midpoint once before accepting the connection.
        if (Math.abs(yb - ya) * m.scaleYpx > JUMP_FLAG_PX) {
            const tm = (a + b) / 2;
            const ym = evalFinite(fn, tm);
            if (ym === undefined || outOfRange(ym, m)) {
                return { points: [], broke: true, breakX: tm };
            }
        }
        return { points: [{ x: b, y: yb }], broke: false };
    }
    const mid = (a + b) / 2;
    const ym = evalFinite(fn, mid);
    if (ym === undefined || outOfRange(ym, m)) {
        return { points: [], broke: true, breakX: mid };
    }
    const chord = ya + (yb - ya) * (mid - a) / (b - a);
    if (Math.abs(ym - chord) * m.scaleYpx <= FLATNESS_PX) {
        return { points: [{ x: b, y: yb }], broke: false };
    }
    const left = subdivide(fn, a, ya, mid, ym, m, depth - 1);
    if (left.broke) return left;
    const right = subdivide(fn, mid, ym, b, yb, m, depth - 1);
    return right.broke
        ? { points: [...left.points, ...right.points], broke: true, breakX: right.breakX }
        : { points: [...left.points, ...right.points], broke: false };
}

/** Cluster asymptote x positions within SIDE_OFFSET_PX of each other. */
function dedupeAsymptotes(xs: number[], m: PixelMetrics): number[] {
    if (xs.length === 0) return [];
    const sorted = [...xs].sort((p, q) => p - q);
    const out: number[] = [sorted[0]];
    const minGap = SIDE_OFFSET_PX / m.scaleXpx;
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - out[out.length - 1] > minGap) {
            out.push(sorted[i]);
        }
    }
    return out;
}

/**
 * Sample a compiled function over [xMin, xMax], producing polyline
 * segments plus detected vertical asymptote positions.
 *
 * Sampling is adaptive: a coarse base pass (every BASE_SPACING_PX
 * pixels) is refined by bisection only where the curve deviates from
 * its chord, and suspected jumps/poles are localized by bisection.
 * nSamples is only used as a fallback when the pixel width is unknown.
 */
export function sampleFunction(
    fn: (x: number) => number,
    params: SamplerParams
): SampleResult {
    const { xRange, yRange, nSamples } = params;
    const [xMin, xMax] = xRange;

    const pixelWidth = params.pixelWidth > 0 ? params.pixelWidth : FALLBACK_PIXEL_WIDTH;
    const pixelHeight = params.pixelHeight && params.pixelHeight > 0
        ? params.pixelHeight
        : FALLBACK_PIXEL_HEIGHT;

    const n = params.pixelWidth > 0
        ? Math.min(MAX_BASE_SAMPLES,
            Math.max(MIN_BASE_SAMPLES, Math.round(pixelWidth / BASE_SPACING_PX)))
        : Math.max(2, nSamples);
    const step = (xMax - xMin) / (n - 1);

    // Reject y values far outside the viewport: points near asymptotes
    // with extreme values would otherwise create long vertical lines.
    // A small margin beyond the viewport keeps legitimate steep curves.
    const yLo = yRange[0];
    const yHi = yRange[1];
    const ySpan = yHi - yLo;

    const m: PixelMetrics = {
        scaleXpx: pixelWidth / (xMax - xMin),
        scaleYpx: pixelHeight / ySpan,
        pixelHeight,
        yRejectLo: yLo - ySpan * 0.5,
        yRejectHi: yHi + ySpan * 0.5
    };

    // --- Base pass: keep finite in-range samples, note gaps ---
    const points: SamplePoint[] = [];
    let sawUndefined = false;
    let undefinedAt: number | undefined;
    for (let i = 0; i < n; i++) {
        const x = xMin + step * i;
        const y = evalFinite(fn, x);
        if (y === undefined) {
            // NaN / Infinity sample: the function is undefined here.
            sawUndefined = true;
            undefinedAt = x;
            continue;
        }
        if (outOfRange(y, m)) continue; // finite, just out of view
        points.push({
            x,
            y,
            gapBefore: sawUndefined ? "undefined" : undefined,
            gapAt: undefinedAt
        });
        sawUndefined = false;
        undefinedAt = undefined;
    }
    if (points.length < 2) {
        return points.length
            ? { segments: [{ points: [...points] }], asymptotes: [] }
            : { segments: [], asymptotes: [] };
    }

    // --- Segment building: classify each interval between kept samples ---
    const segments: PolylineSegment[] = [];
    const asymptotes: number[] = [];
    let current: Array<{ x: number; y: number }> = [points[0]];

    // Break location just before the next kept point (set when a segment
    // is closed at a discontinuity, consumed when the next one starts).
    let pendingBreakX: number | undefined;

    const closeSegment = () => {
        if (current.length > 1) segments.push({ points: current });
        current = [];
    };
    /**
     * Extend the current segment from p toward a break at breakX,
     * stopping at the margin crossing (where y leaves the reject range).
     * Without this, branches stop one base-sample short of a pole, and
     * the missing length varies with the sampling-grid phase.
     */
    const extendToBreak = (p: { x: number; y: number }, breakX: number): void => {
        const b = marginBoundary(fn, p.x, breakX, m);
        const yb = evalFinite(fn, b);
        if (yb === undefined) return;
        current.push(...subdivide(fn, p.x, p.y, b, yb, m, MAX_REFINE_DEPTH).points);
    };
    /**
     * Start the current segment at the margin crossing near breakX and
     * refine up to p (the first kept sample after the break).
     */
    const extendFromBreak = (p: SamplePoint, breakX: number): void => {
        const b = marginBoundary(fn, p.x, breakX, m);
        const yb = evalFinite(fn, b);
        if (yb === undefined) {
            current.push({ x: p.x, y: p.y });
            return;
        }
        // subdivide excludes its left endpoint, so the margin crossing
        // itself must be pushed - otherwise every post-break branch
        // starts one subdivision point late (asymmetric: the ascending
        // side reaches the margin via extendToBreak, the descending
        // side would not).
        current.push({ x: b, y: yb });
        current.push(...subdivide(fn, b, yb, p.x, p.y, m, MAX_REFINE_DEPTH).points);
    };
    /** Ensure `current` is started before refining the interval at p0. */
    const ensureStart = (p0: SamplePoint): void => {
        if (current.length > 0) return;
        if (pendingBreakX !== undefined) {
            extendFromBreak(p0, pendingBreakX);
            pendingBreakX = undefined;
        } else {
            current.push({ x: p0.x, y: p0.y });
        }
    };
    /**
     * Refine a connected interval and append its points to `current`.
     * When the refinement hits a pole mid-interval, treat it exactly
     * like a classified split: extend the left branch to the margin
     * crossing, close, and remember the break so the next segment
     * starts at the margin on the other side (plus probe for an
     * asymptote). Otherwise the branch would stop wherever bisection
     * first saw an out-of-range midpoint, with a length that depends
     * on the subdivision path.
     */
    const emitInterval = (
        p0: SamplePoint,
        p1: SamplePoint
    ): void => {
        const res = subdivide(fn, p0.x, p0.y, p1.x, p1.y, m, MAX_REFINE_DEPTH);
        current.push(...res.points);
        if (!res.broke) return;
        if (res.breakX === undefined) {
            closeSegment();
            return;
        }
        const last = current[current.length - 1];
        if (last && last.x < res.breakX) extendToBreak(last, res.breakX);
        closeSegment();
        pendingBreakX = res.breakX;
        if (divergesAt(fn, res.breakX, m)) asymptotes.push(res.breakX);
    };

    for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1];
        const p1 = points[i];

        // Consume any pending break first: every path below may close
        // the current segment, and a break from the previous interval
        // must extend into this one or the curve between the two
        // breaks is silently dropped (chains of flagged intervals are
        // common when zoomed out).
        ensureStart(p0);

        // The function was NaN/Infinity somewhere between p0 and p1:
        // always a break (user-visible undefined region).
        if (p1.gapBefore === "undefined") {
            const gx = p1.gapAt;
            if (gx !== undefined) extendToBreak(p0, gx);
            closeSegment();
            pendingBreakX = gx;
            // If the function diverges around the undefined point, it is
            // a pole - report it for asymptote rendering.
            if (gx !== undefined && divergesAt(fn, gx, m)) {
                asymptotes.push(gx);
            }
            continue;
        }

        if (Math.abs(p1.y - p0.y) * m.scaleYpx <= JUMP_FLAG_PX) {
            // Smooth at base scale - geometric refinement only.
            emitInterval(p0, p1);
        } else {
            // Flagged jump - classify, then refine if it stays connected.
            const jv = classifyJump(fn, p0.x, p0.y, p1.x, p1.y, m, MAX_CLASSIFY_DEPTH);
            if (jv.verdict === "connect") {
                emitInterval(p0, p1);
            } else if (jv.verdict === "split-keep") {
                // Snap the break to the actual jump position so each
                // side is drawn all the way to the transition. The
                // right value comes from p1: the converged breakX can
                // sit a hair left of the jump (e.g. floor(-1.0003)
                // is still the left value).
                const jx = locateJump(fn, p0.x, p0.y, p1.x, p1.y, m);
                current.push({ x: jx, y: p0.y });
                closeSegment();
                current = [{ x: jx, y: p1.y }, p1];
            } else {
                if (jv.breakX !== undefined) extendToBreak(p0, jv.breakX);
                closeSegment();
                pendingBreakX = jv.breakX;
                if (jv.asymptoteX !== undefined) asymptotes.push(jv.asymptoteX);
            }
        }
    }
    if (current.length > 0) closeSegment();

    return {
        segments: segments.length ? segments : [],
        asymptotes: dedupeAsymptotes(asymptotes, m)
    };
}

/**
 * The built-in sampler implementation.
 * Takes a raw GGB expression string, compiles, and samples.
 */
export const builtinSampler: SamplerFn = (
    expression: string,
    params: SamplerParams
): SampleResult => {
    const fn = compileExpression(expression, params.angleUnit);
    return sampleFunction(fn, params);
};
