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

import {
    parse as mathParse,
    FunctionNode,
    type EvalFunction,
    type MathNode
} from "mathjs";
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
export function splitTopLevel(s: string): string[] {
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
        // GeoGebra writes the mathematical constant e as the Unicode
        // "SCRIPT SMALL E" (U+212F), sometimes U+2147 (ⅇ). mathjs uses
        // plain "e", so normalize both before compiling - otherwise
        // evaluation throws "Undefined symbol ℯ" and the whole curve
        // renders as nothing (e.g. sinh: (ℯ^x - ℯ^(-x))/2).
        .replace(/ℯ|ⅇ/g, "e")
        .replace(/≤/g, "<=")
        .replace(/≥/g, ">=")
        .replace(/≠/g, "!=")
        .replace(/≟/g, "==")
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
 * Real-branch power for GeoGebra semantics.
 *
 * mathjs evaluates `a ^ b` for a negative base and a non-integer exponent
 * via the complex principal branch — e.g. `(-8) ^ (1/3)` yields
 * `1 + 1.73i` rather than the real cube root `-2`. GeoGebra takes the real
 * branch: when `b` is a rational `p/q` (in lowest terms) with odd
 * denominator `q`, the result is the real `(-1)^p * |a|^(p/q)`; an even
 * denominator (a square/cube root of a negative) is genuinely undefined.
 *
 * Without this, a cube-root curve `y = x^(1/3)` samples as NaN for `x < 0`
 * and the whole third quadrant goes unrendered. We rewrite the `^`
 * operator into this helper so the real branch is used where it exists,
 * and irrational/even-denominator exponents still fall back to NaN.
 *
 * `q` is found numerically by scanning odd denominators; the `(-1)^p` sign
 * is correct for any representation of a reduced odd-denominator fraction,
 * so the small search bound covers realistic hand-written exponents.
 */
function ggbPow(base: number, exp: number): number {
    if (typeof base !== "number" || typeof exp !== "number") {
        return Math.pow(base as number, exp as number);
    }
    if (base >= 0 || Number.isInteger(exp)) {
        return Math.pow(base, exp);
    }
    // base < 0, exp non-integer: real branch only for rational p/q, q odd.
    const absBase = Math.abs(base);
    for (let q = 1; q <= 1001; q += 2) {
        const pFloat = exp * q;
        const p = Math.round(pFloat);
        if (p !== 0 && Math.abs(pFloat - p) < 1e-9) {
            return Math.pow(-1, p) * Math.pow(absBase, exp);
        }
    }
    // Irrational or even-denominator exponent on a negative base:
    // undefined over the reals, matching GeoGebra.
    return NaN;
}

/** Identifier used as the rewritten power function name in the scope. */
const GGB_POW_FN = "__ggbPow";

/**
 * Rewrite every `^` operator node into a call to {@link ggbPow} (named
 * {@link GGB_POW_FN}) so negative bases evaluate via the real branch.
 */
function rewritePowerToRealBranch(node: MathNode): MathNode {
    return node.transform((n) => {
        if (n.type === "OperatorNode" && (n as unknown as { op: string }).op === "^") {
            const fn = n as unknown as {
                args: MathNode[];
                fn: string;
            };
            return new FunctionNode(GGB_POW_FN, fn.args) as MathNode;
        }
        return n;
    });
}

/**
 * Scope entry that makes the rewritten `^` resolve to {@link ggbPow}. Merge
 * this into any scope passed to an expression compiled by {@link compileMath}.
 */
export const GGB_POW_SCOPE: Record<string, (base: number, exp: number) => number> = {
    [GGB_POW_FN]: ggbPow
};

/**
 * Compile a mathjs expression string (already translated from GeoGebra via
 * {@link ggbToMathJs}) with the real-branch power rewrite applied. Shared by
 * the sampler (curve rendering) and the kernel (point/value evaluation) so
 * both agree on `(-8)^(1/3) = -2` — otherwise the rendered curve and the
 * computed point `A = (a, f(a))` would diverge for `a < 0` (curve real,
 * point complex→NaN). Callers must merge {@link GGB_POW_SCOPE} into the
 * evaluation scope.
 */

/**
 * Compiled-expression cache keyed by the (already-translated) mathjs text.
 *
 * The recursive evaluator {@link evalGgbNum} reduces higher-order constructs to
 * numbers and leaves a plain-arithmetic residue (e.g.
 * `(0.6366) * cos((1 * x)) + (1.0) * sin((1 * x))`) that it then compiles. That
 * residue is identical across every sample point of one rebuild (only the
 * variable `x` differs at evaluate time, and `x` stays symbolic in the text),
 * so without this cache each rendered point re-parses and re-compiles the same
 * expression — O(k) compiles per point for a Fourier sum, ~1.5s/frame at k=30
 * and visible drag stutter. Caching makes it O(k) compiles per *rebuild* total.
 * Bounded; cleared wholesale when it would grow past {@link COMPILE_CACHE_MAX}.
 */
const COMPILE_CACHE_MAX = 8192;
const compileCache = new Map<string, EvalFunction>();

export function compileMath(mathjsExpr: string): EvalFunction {
    const cached = compileCache.get(mathjsExpr);
    if (cached) return cached;
    if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear();
    const compiled = rewritePowerToRealBranch(mathParse(mathjsExpr)).compile();
    compileCache.set(mathjsExpr, compiled);
    return compiled;
}

/**
 * Extract the independent-variable name from a GeoGebra function expression
 * of the form `name(var) = body` (e.g. `f(t) = sin(t)` → `"t"`). GeoGebra lets
 * the function variable be any identifier, not just `x`; without this the
 * variable would be undefined at evaluation time and the whole curve would
 * sample as NaN. Falls back to `"x"` when there is no `name(var) =` prefix
 * (preserving the previous behaviour for bare expressions).
 */
function parseFunctionVar(expression: string): string {
    const m = /^[A-Za-z_]\w*\s*\(\s*([A-Za-z_]\w*)\s*\)\s*=/.exec(expression);
    return m ? m[1] : "x";
}

/**
 * Detect the bound variable of a function expression like `f(t) = ...` (or
 * fall back to `x`). Exported so the kernel can compile a per-point closure
 * against the correct symbol — a function whose variable is `t` would
 * otherwise be sampled as all-NaN when the closure assumes `x`.
 */
export function detectFunctionVar(expression: string): string {
    return parseFunctionVar(expression);
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
 * @param scope  external values the expression may reference (e.g. a slider
 *               `α` in `If[-2 <= t <= α, ...]`). The function variable is set
 *               from the `name(var) =` prefix; scope supplies the rest.
 * @returns function that takes x and returns y, or NaN if undefined
 */
export function compileExpression(
    expression: string,
    angleUnit: "degree" | "radian" = "radian",
    scope?: Record<string, number>
): (x: number) => number {
    const rhs = ggbToMathJs(extractExpression(expression));
    const varName = parseFunctionVar(expression);
    let compiled: EvalFunction;

    try {
        // Rewrite `^` into the real-branch power helper so curves like
        // `y = x^(1/3)` evaluate to real values for x < 0 instead of the
        // complex principal branch (which samples as NaN and is dropped).
        compiled = compileMath(rhs);
    } catch {
        // If compilation fails, return a function that always yields NaN
        return () => NaN;
    }

    return (x: number): number => {
        try {
            const result = compiled.evaluate({
                ...scope,
                [varName]: x,
                ...GGB_POW_SCOPE
            });
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
    const fn = compileExpression(expression, params.angleUnit, params.scope);
    return sampleFunction(fn, params);
};

// ============================================================
// Parametric curves (GeoGebra CurveCartesian)
// ============================================================

/** Extract a JS number from a mathjs result (Complex/Unit/Matrix fallback). */
function extractNumber(r: unknown): number {
    if (typeof r === "number") return r;
    if (r && typeof (r as { valueOf?: () => unknown }).valueOf === "function") {
        const v = (r as { valueOf: () => unknown }).valueOf();
        if (typeof v === "number") return v;
    }
    return NaN;
}

/**
 * Evaluate a GeoGebra scalar expression (e.g. `"0"`, `"(2*pi)"`) against a
 * scope. Used to resolve CurveCartesian parameter-range endpoints at draw
 * time so ranges like `2*pi` resolve without hard-coding.
 */
function evalGgbNumber(expr: string, scope: Record<string, unknown>): number {
    try {
        const compiled = compileMath(ggbToMathJs(expr));
        return extractNumber(compiled.evaluate({ ...scope, ...GGB_POW_SCOPE }));
    } catch {
        return NaN;
    }
}

// ============================================================
// Higher-order GeoGebra commands: Integral, Sum, Sequence, Element
//
// mathjs cannot evaluate these because (a) they are unknown functions
// and (b) its eager argument evaluation defeats `Integral[g(x), a, b]`
// (the integrand must be re-evaluated per quadrature node with the
// integration variable bound) and `Sum[Sequence[g, v, 1, k]]` (the end
// `k` is a runtime value, so the sum can't be textually unrolled at
// compile time). We handle them structurally here, recursing with the
// correct variable binding, and fall back to mathjs for the plain
// arithmetic residue (`a_0 / 2`, `cos(n * x)`, `f(x)`, ...).
// ============================================================

/** GeoGebra command names handled structurally (exact case, `[` arg syntax). */
const GGB_COMMANDS = ["Integral", "Element", "Sum", "Sequence"] as const;

/** Find the index of the matching `]` for the `[` at `openIdx`. -1 if unbalanced. */
function matchBracket(s: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
        const c = s[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

interface ConstructCall {
    name: string;
    /** Index of the name's first char. */
    start: number;
    /** Index just past the closing `]`. */
    end: number;
    /** Bracketed body (between `[` and `]`). */
    body: string;
}

/**
 * If `s` (trimmed) is exactly one GeoGebra command call `Name[...]`,
 * return it; otherwise undefined.
 */
function matchWholeConstruct(s: string): ConstructCall | undefined {
    const t = s.trim();
    for (const name of GGB_COMMANDS) {
        if (t.startsWith(name) && t[name.length] === "[") {
            const close = matchBracket(t, name.length);
            if (close === t.length - 1 && close > name.length) {
                return { name, start: 0, end: t.length, body: t.slice(name.length + 1, close) };
            }
        }
    }
    return undefined;
}

/** Word-boundary test for a construct name match at position `i`. */
function isConstructAt(s: string, name: string, i: number): boolean {
    if (s.slice(i, i + name.length) !== name) return false;
    if (s[i + name.length] !== "[") return false;
    const prev = i > 0 ? s[i - 1] : " ";
    // Must not be a continuation of a longer identifier (e.g. `mySum[`).
    return !/[A-Za-z0-9_]/.test(prev);
}

/** Count only the named constructs in `s`. */
function countConstructsIn(s: string, names: readonly string[]): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        for (const name of names) {
            if (isConstructAt(s, name, i)) { n++; i += name.length; break; }
        }
    }
    return n;
}

/**
 * Composite Simpson's rule over `[a, b]` (N even). Doubles N until the
 * estimate converges relative to `1e-4` (cap 4096), so oscillatory
 * integrands like `f(x)·cos(n·x)` for large `n` stay accurate without a
 * fixed huge node count.
 */
function simpsonAdaptive(
    g: (x: number) => number,
    a: number,
    b: number
): number {
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return NaN;
    let prev = NaN;
    let N = 128;
    for (let pass = 0; pass < 6; pass++) {
        if (N > 4096) N = 4096;
        let sum = g(a) + g(b);
        const h = (b - a) / N;
        for (let i = 1; i < N; i++) {
            const x = a + i * h;
            sum += (i % 2 === 0 ? 2 : 4) * g(x);
        }
        const est = (h / 3) * sum;
        if (Number.isFinite(prev) && Math.abs(est - prev) <= 1e-4 * (1 + Math.abs(est))) {
            return est;
        }
        prev = est;
        N *= 2;
    }
    return prev;
}

/**
 * Evaluate a GeoGebra expression to a number, handling the higher-order
 * commands `Integral`/`Element`/`Sum`/`Sequence` structurally and falling
 * back to mathjs for plain arithmetic.
 */
export function evalGgbNum(expr: string, scope: Record<string, unknown>): number {
    const s = ggbToMathJs(expr);

    // Whole expr is a single construct call → dispatch directly.
    const whole = matchWholeConstruct(s);
    if (whole) {
        const args = splitTopLevel(whole.body);
        switch (whole.name) {
            case "Integral": {
                // Integral[g, a, b]  or  Integral[g, var, a, b]
                let gIdx = 0, varName = "x", aIdx = 1, bIdx = 2;
                if (args.length === 4) { varName = args[1].trim(); aIdx = 2; bIdx = 3; }
                const g = args[gIdx];
                const a = evalGgbNum(args[aIdx], scope);
                const b = evalGgbNum(args[bIdx], scope);
                return simpsonAdaptive(
                    (x) => evalGgbNum(g, { ...scope, [varName]: x }),
                    a, b
                );
            }
            case "Element": {
                const li = evalGgbList(args[0], scope);
                const idx = evalGgbNum(args[1], scope);
                const i = Math.round(idx) - 1;
                return Number.isInteger(i) && i >= 0 && i < li.length ? li[i] : NaN;
            }
            case "Sum": {
                const li = evalGgbList(args[0], scope);
                return li.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
            }
            case "Sequence":
                // A bare Sequence is not a number; it is consumed by Sum/Element.
                return NaN;
        }
    }

    // Embedded in arithmetic, or pure: reduce innermost number-producing
    // constructs to literals, then evaluate the residue with mathjs.
    let cur = s;
    for (let guard = 0; guard < 1000; guard++) {
        const c = findInnermostNumeric(cur);
        if (!c) break;
        const val = evalGgbNum(cur.slice(c.start, c.end), scope);
        cur = cur.slice(0, c.start) + `(${val})` + cur.slice(c.end);
    }
    try {
        const compiled = compileMath(cur);
        return extractNumber(compiled.evaluate({ ...scope, ...GGB_POW_SCOPE }));
    } catch {
        return NaN;
    }
}

/**
 * Find the innermost construct among {Integral, Element, Sum} whose body
 * contains no {Integral, Element, Sum} construct (a `Sequence` body is
 * allowed — it is consumed by `Sum`/`Element` via `evalGgbList`).
 */
function findInnermostNumeric(s: string): ConstructCall | undefined {
    const numericNames = ["Integral", "Element", "Sum"];
    let best: ConstructCall | undefined;
    let bestInner = Infinity;
    for (let i = 0; i < s.length; i++) {
        for (const name of numericNames) {
            if (!isConstructAt(s, name, i)) continue;
            const close = matchBracket(s, i + name.length);
            if (close === -1) continue;
            const body = s.slice(i + name.length + 1, close);
            const inner = countConstructsIn(body, numericNames);
            if (inner < bestInner) {
                bestInner = inner;
                best = { name, start: i, end: close + 1, body };
            }
            i = close;
            break;
        }
    }
    return bestInner === Infinity ? undefined : best;
}

/**
 * Evaluate a GeoGebra expression to a list of numbers: a `Sequence`
 * producing scalars, or a bare list label (e.g. `a_n`) resolved from scope.
 */
export function evalGgbList(expr: string, scope: Record<string, unknown>): number[] {
    const s = ggbToMathJs(expr).trim();
    const whole = matchWholeConstruct(s);
    if (whole && whole.name === "Sequence") {
        const args = splitTopLevel(whole.body);
        // Sequence[g, var, start, end, step?]
        const g = args[0];
        const v = (args[1] ?? "i").trim();
        const start = evalGgbNum(args[2] ?? "1", scope);
        const end = evalGgbNum(args[3] ?? "1", scope);
        const step = args[4] ? evalGgbNum(args[4], scope) : 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || !step || !Number.isFinite(step)) {
            return [];
        }
        const out: number[] = [];
        const dir = step > 0 ? 1 : -1;
        let val = start;
        let iter = 0;
        while (dir > 0 ? val <= end + 1e-9 : val >= end - 1e-9) {
            if (iter++ > 100000) break;
            out.push(evalGgbNum(g, { ...scope, [v]: val }));
            val += step;
        }
        return out;
    }
    // Bare list label in scope (e.g. a_n, b_n).
    const direct = scope[s];
    if (Array.isArray(direct)) return direct.map((v) => Number(v));
    // Fallback: try mathjs (array literal / matrix).
    try {
        const r = compileMath(s).evaluate({ ...scope, ...GGB_POW_SCOPE });
        if (Array.isArray(r)) return r.map((v) => Number(v));
        if (r && typeof (r as { toArray?: () => unknown[] }).toArray === "function") {
            return (r as { toArray: () => unknown[] }).toArray().map((v) => Number(v));
        }
    } catch {
        // fall through
    }
    return [];
}

// ============================================================
// Closure compiler — one parse per rebuild, evaluate-per-point
//
// {@link evalGgbNum} re-parses the expression on every sample point (it
// reduces constructs to literals then recompiles the residue). For a slider-
// driven Fourier sum that is ~k string recompiles per rendered point —
// hundreds of ms per frame and visible drag stutter, even with the compile
// cache (the residue text is constant, but the string scanning, top-level
// splitting and scope spreading still happen per point).
//
// `compileToClosure` instead turns the expression into a single JS closure
// once per rebuild. Rebuild-time-fixed quantities — free numbers, scalar
// lists, `Integral` coefficients, `Sequence` extents — are resolved into the
// closure; only the function variable stays symbolic. A rendered point then
// costs just a tight multiply-add loop over the precomputed terms, no mathjs
// parsing or string work. Falls back to {@link evalGgbNum} when the structure
// is not understood (correctness is never sacrificed for speed).
// ============================================================

/** Resolve a bare identifier against scope, or undefined if absent/unknown. */
function lookupScalar(label: string, scope: Record<string, unknown>): unknown {
    const t = label.trim();
    const v = scope[t];
    if (typeof v === "number") return v;
    if (typeof v === "function") return v; // a referenced function value
    if (Array.isArray(v)) return v; // a scalar list
    return undefined;
}

/**
 * Compile `expr` into a fast `(x) => number`, resolving everything that is
 * fixed across sample points at build time against `scope`. `varName` is the
 * only symbol kept symbolic (the function variable). Returns `undefined`
 * when the structure is not understood — callers fall back to evalGgbNum.
 */
export function compileToClosure(
    expr: string,
    scope: Record<string, unknown>,
    varName = "x"
): ((x: number) => number) | undefined {
    const s = ggbToMathJs(expr).trim();

    // A bare reference to a known function value → delegate to it.
    const direct = lookupScalar(s, scope);
    if (typeof direct === "function") return (x) => (direct as (x: number) => number)(x);

    // Whole expr is a single construct call.
    const whole = matchWholeConstruct(s);
    if (whole) {
        const args = splitTopLevel(whole.body);
        switch (whole.name) {
            case "Sum": {
                // Sum[Sequence[term, v, s, e]] or Sum[listLabel].
                const terms = compileListTerms(args[0], scope, varName);
                if (!terms) return undefined;
                return (x) => {
                    let acc = 0;
                    for (const t of terms) {
                        const v = t(x);
                        if (Number.isFinite(v)) acc += v;
                    }
                    return acc;
                };
            }
            case "Sequence":
                // A bare Sequence is not a scalar; only meaningful inside Sum.
                return undefined;
            case "Element": {
                const li = evalGgbList(args[0], scope);
                const idx = evalGgbNum(args[1], scope);
                const i = Math.round(idx) - 1;
                const v = Number.isInteger(i) && i >= 0 && i < li.length ? li[i] : NaN;
                return () => v;
            }
            case "Integral":
                // Bound to the function variable by default (rare here).
                return compileIntegralClosure(args, scope, varName);
        }
    }

    // A top-level sum embedded in arithmetic, e.g. `a_0 / 2 + Sum[...]`.
    // Reduce each innermost construct to a closure and splice it into the
    // residue as a call to a scope-bound function `__ggbt<i>(x)`, then
    // compile the residue once. At evaluate time each `__ggbt<i>` is the
    // closure (which closes over x), so the call yields its x-dependent
    // value. Numeric scope values (sliders, the Sequence loop variable
    // baked by callers) are spliced as literals so the residue only
    // references the symbolic function variable plus these helpers.
    const refs: Array<(x: number) => number> = [];
    let residue = s;
    let guard = 0;
    while (guard++ < 1000) {
        const c = findInnermostClosureTarget(residue);
        if (!c) break;
        const sub = compileToClosure(residue.slice(c.start, c.end), scope, varName);
        if (!sub) return undefined; // structure not understood → fall back
        const name = `__ggbt${refs.length}`;
        refs.push(sub);
        // Call with the function variable so x-dependent constructs (Sum)
        // receive it; constant constructs ignore the argument.
        residue =
            residue.slice(0, c.start) + `${name}(${varName})` + residue.slice(c.end);
    }
    // Bake numeric (non-symbolic) scope entries into the residue text.
    for (const key of Object.keys(scope)) {
        if (key === varName) continue;
        const v = scope[key];
        if (typeof v === "number" && referencesSymbol(residue, key)) {
            residue = replaceSymbol(residue, key, formatNumber(v));
        }
    }
    try {
        const compiled = compileMath(residue);
        const fnScope: Record<string, unknown> = { ...scope, ...GGB_POW_SCOPE };
        refs.forEach((fn, i) => { fnScope[`__ggbt${i}`] = fn; });
        return (x) => {
            try {
                fnScope[varName] = x;
                return extractNumber(compiled.evaluate(fnScope));
            } catch {
                return NaN;
            }
        };
    } catch {
        return undefined;
    }
}

/**
 * Find the innermost Sum/Element/Integral whose body holds no such construct,
 * so it can be reduced to a single closure first. (Sequence is expanded
 * inside `compileListTerms`, not here.)
 */
function findInnermostClosureTarget(s: string): ConstructCall | undefined {
    const names = ["Integral", "Element", "Sum"];
    let best: ConstructCall | undefined;
    let bestInner = Infinity;
    for (let i = 0; i < s.length; i++) {
        for (const name of names) {
            if (!isConstructAt(s, name, i)) continue;
            const close = matchBracket(s, i + name.length);
            if (close === -1) continue;
            const body = s.slice(i + name.length + 1, close);
            const inner = countConstructsIn(body, names);
            if (inner < bestInner) {
                bestInner = inner;
                best = { name, start: i, end: close + 1, body };
            }
            i = close;
            break;
        }
    }
    return bestInner === Infinity ? undefined : best;
}

/**
 * Compile a `Sum` operand into an array of per-term closures over the function
 * variable. Handles `Sequence[term, v, s, e]` (expanded: each integer value of
 * `v` yields a closure that keeps only `varName` symbolic) and bare list
 * labels (constant terms). Returns undefined when not understood.
 */
function compileListTerms(
    expr: string,
    scope: Record<string, unknown>,
    varName: string
): Array<(x: number) => number> | undefined {
    const s = ggbToMathJs(expr).trim();
    const whole = matchWholeConstruct(s);
    if (whole && whole.name === "Sequence") {
        const args = splitTopLevel(whole.body);
        const term = args[0];
        const v = (args[1] ?? "i").trim();
        const start = evalGgbNum(args[2] ?? "1", scope);
        const end = evalGgbNum(args[3] ?? "1", scope);
        const step = args[4] ? evalGgbNum(args[4], scope) : 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || !step || !Number.isFinite(step)) {
            return [];
        }
        const out: Array<(x: number) => number> = [];
        const dir = step > 0 ? 1 : -1;
        let val = start;
        let iter = 0;
        while (dir > 0 ? val <= end + 1e-9 : val >= end - 1e-9) {
            if (iter++ > 100000) break;
            // Bake the loop variable's value into the term text as a literal so
            // it compiles directly into the residue (e.g. `cos((n * x))` →
            // `cos((1 * x))`). Otherwise `n` would stay symbolic and be absent
            // from the per-point evaluate scope, yielding NaN. Whole-token
            // replace so `n` doesn't match inside `a_n`/`b_n` etc.
            const bound = replaceSymbol(term, v, formatNumber(val));
            const sub = compileToClosure(bound, scope, varName);
            if (!sub) return undefined;
            out.push(sub);
            val += step;
        }
        return out;
    }
    // Bare list label → constant terms (rare for a Sum operand, but supported).
    const li = evalGgbList(s, scope);
    if (li.length) return li.map((c) => () => c);
    return undefined;
}

/** Compile `Integral[g, a, b]` (or `Integral[g, var, a, b]`) to a closure. */
function compileIntegralClosure(
    args: string[],
    scope: Record<string, unknown>,
    varName: string
): ((x: number) => number) | undefined {
    let gIdx = 0, iv = varName, aIdx = 1, bIdx = 2;
    if (args.length === 4) { iv = args[1].trim(); aIdx = 2; bIdx = 3; }
    const g = args[gIdx];
    const a = evalGgbNum(args[aIdx], scope);
    const b = evalGgbNum(args[bIdx], scope);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    // If the integrand references the function variable, the value depends on
    // x → build an x-dependent closure; otherwise it is a fixed constant.
    const dependsOnVar = referencesSymbol(g, iv) || iv === varName;
    if (!dependsOnVar) {
        const fixed = simpsonAdaptive(
            (t) => evalGgbNum(g, { ...scope, [iv]: t }), a, b
        );
        return () => fixed;
    }
    return (x) => simpsonAdaptive(
        (t) => evalGgbNum(g, { ...scope, [iv]: t, [varName]: x }), a, b
    );
}

/** True if `expr` textually mentions identifier `name` as a standalone token. */
function referencesSymbol(expr: string, name: string): boolean {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(name)}([^A-Za-z0-9_]|$)`);
    return re.test(expr);
}

/** Replace standalone-token occurrences of identifier `name` with `lit`. */
function replaceSymbol(expr: string, name: string, lit: string): string {
    const re = new RegExp(
        `(^|[^A-Za-z0-9_])${escapeRe(name)}([^A-Za-z0-9_]|$)`,
        "g"
    );
    // Preserve the boundary chars (the leading/trailing non-identifier) so
    // chained replacements like `n * n` stay correct.
    return expr.replace(re, (_m, pre, post) => `${pre}${lit}${post}`);
}

/** Escape a literal for use inside a RegExp. */
function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compact numeric literal for splicing into expressions. */
function formatNumber(n: number): string {
    return Number.isFinite(n) ? String(n) : "0";
}

/**
 * Split a CurveCartesian point expression into its two coordinate
 * sub-expressions and report GeoGebra's coordinate mode.
 *
 * GeoGebra writes points with a `;` separator for **polar** coordinates
 * `(radius; angle)` and a `,` separator for **Cartesian** `(x, y)` (this is the
 * same distinction the kernel's `convertTuplesToArrays` relies on — it treats
 * only `,` as a tuple separator, leaving `;` for polar). The whole pair may be
 * wrapped in an outer pair of parentheses, which is stripped.
 *
 * Returns `{ mode, parts }` where `parts` is `[a, b]`: for Cartesian `[x, y]`,
 * for polar `[radius, angle]`. `undefined` if there is no top-level separator.
 */
function splitParametricPoint(
    pointExpr: string
): { mode: "polar" | "cartesian"; parts: [string, string] } | undefined {
    let s = pointExpr.trim();
    // Strip one layer of surrounding parentheses if they wrap the whole expr.
    if (s.startsWith("(") && s.endsWith(")")) {
        // Verify the first paren matches the last (balanced outer wrap).
        let depth = 0;
        let wraps = true;
        for (let i = 0; i < s.length; i++) {
            if (s[i] === "(") depth++;
            else if (s[i] === ")") {
                depth--;
                if (depth === 0 && i !== s.length - 1) { wraps = false; break; }
            }
        }
        if (wraps) s = s.slice(1, -1);
    }
    // Find the top-level separator (`;` polar or `,` cartesian), depth 0.
    let depth = 0;
    let sep = -1;
    let mode: "polar" | "cartesian" = "cartesian";
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (depth === 0 && (c === ";" || c === ",")) {
            sep = i;
            mode = c === ";" ? "polar" : "cartesian";
            break;
        }
    }
    if (sep === -1) return undefined;
    return {
        mode,
        parts: [s.slice(0, sep).trim(), s.slice(sep + 1).trim()]
    };
}

/** Pixel-space marching bounds for parametric sampling (mirror the conic sampler). */
const PMAX_STEP_PX = 3;
const PMIN_STEP_PX = 1;
const PMAX_STEPS = 6000;

/**
 * Sample a `CurveCartesian` parametric curve over `[tStart, tEnd]` into
 * polyline segments. Marches the parameter adaptively so consecutive samples
 * stay ~1–3px apart (zoom-independent), and splits into a new segment wherever
 * the curve goes undefined (NaN/Infinity), mirroring the conic sampler.
 *
 * The point expression is GeoGebra's point form, decoded by
 * {@link splitParametricPoint}:
 *  - Cartesian `(x(t), y(t))` — the two parts ARE x and y.
 *  - Polar `(r(t); φ(t))` — the two parts are radius and angle; the drawn
 *    point is `(r·cos φ, r·sin φ)`. The angle is taken in radians, consistent
 *    with GeoGebra function expressions (`sin(x)` is always radians per
 *    CLAUDE.md) so a rose `r = a·sin(n·θ); θ` over `[0, 2π]` closes correctly
 *    even when `angleUnit` is `degree`.
 */
export function sampleParametricCurve(
    pointExpr: string,
    paramVar: string,
    tRangeExpr: [string, string],
    params: {
        xRange: [number, number];
        yRange: [number, number];
        pixelWidth: number;
        pixelHeight?: number;
        scope?: Record<string, number>;
    }
): PolylineSegment[] {
    const split = splitParametricPoint(pointExpr);
    if (!split) return [];
    const { mode, parts } = split;
    const [aExpr, bExpr] = parts;

    let aFn: EvalFunction;
    let bFn: EvalFunction;
    try {
        aFn = compileMath(ggbToMathJs(aExpr));
        bFn = compileMath(ggbToMathJs(bExpr));
    } catch {
        return [];
    }

    const scope = params.scope ?? {};
    const baseScope = { ...scope, ...GGB_POW_SCOPE };
    const tStart = evalGgbNumber(tRangeExpr[0], baseScope);
    const tEnd = evalGgbNumber(tRangeExpr[1], baseScope);
    if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tStart === tEnd) {
        return [];
    }

    const [xMin, xMax] = params.xRange;
    const [yMin, yMax] = params.yRange;
    const scaleX = params.pixelWidth / Math.max(xMax - xMin, 1e-12);
    const scaleY = (params.pixelHeight ?? params.pixelWidth)
        / Math.max(yMax - yMin, 1e-12);

    // A point is "defined" when both coords are finite. Allow generous bounds:
    // the renderer clips to the canvas, so we keep samples a few screens out.
    const padX = (xMax - xMin) * 2 + 4;
    const padY = (yMax - yMin) * 2 + 4;

    const evalPoint = (t: number): { x: number; y: number; ok: boolean } => {
        try {
            const s = { ...baseScope, [paramVar]: t };
            const a = extractNumber(aFn.evaluate(s));
            const b = extractNumber(bFn.evaluate(s));
            if (mode === "polar") {
                // (r; φ) → (r·cos φ, r·sin φ), φ in radians (see fn doc).
                const x = a * Math.cos(b);
                const y = a * Math.sin(b);
                const ok = Number.isFinite(x) && Number.isFinite(y)
                    && x >= xMin - padX && x <= xMax + padX
                    && y >= yMin - padY && y <= yMax + padY;
                return { x, y, ok: Number.isFinite(a) && Number.isFinite(b) && ok };
            }
            const x = a;
            const y = b;
            const ok = Number.isFinite(x) && Number.isFinite(y)
                && x >= xMin - padX && x <= xMax + padX
                && y >= yMin - padY && y <= yMax + padY;
            return { x, y, ok: Number.isFinite(x) && Number.isFinite(y) && ok };
        } catch {
            return { x: NaN, y: NaN, ok: false };
        }
    };

    const segments: PolylineSegment[] = [];
    let current: PolylineSegment = { points: [] };
    const pushSeg = () => {
        if (current.points.length > 1) segments.push(current);
        current = { points: [] };
    };

    const dir = tEnd > tStart ? 1 : -1;
    let t = tStart;
    let dt = dir; // adapted by the first distance check
    let prev = evalPoint(t);
    if (prev.ok) current.points.push({ x: prev.x, y: prev.y });

    for (let i = 0; i < PMAX_STEPS; i++) {
        const p = evalPoint(t + dt);
        const dpx = Math.hypot((p.x - prev.x) * scaleX, (p.y - prev.y) * scaleY);

        if (p.ok && dpx > PMAX_STEP_PX && Math.abs(dt) > 1e-12) {
            dt /= 2; // too coarse — halve the parameter step and retry
            continue;
        }

        // Crossed a NaN / out-of-bounds boundary → break the segment.
        if (!p.ok) {
            // Only advance t; if the curve comes back into range it starts a new seg.
            if (prev.ok) pushSeg();
            t += dt;
            prev = p;
            // Try to re-acquire once on the far side of the gap.
            const probe = evalPoint(t);
            if (probe.ok) {
                prev = probe;
                current.points.push({ x: probe.x, y: probe.y });
            }
            continue;
        }

        t += dt;
        prev = p;
        current.points.push({ x: p.x, y: p.y });

        // Reached the end?
        if ((dir > 0 && t >= tEnd) || (dir < 0 && t <= tEnd)) {
            // Clamp the final sample to tEnd for a clean join.
            const end = evalPoint(tEnd);
            if (end.ok) current.points.push({ x: end.x, y: end.y });
            break;
        }
        if (dpx < PMIN_STEP_PX) dt *= 2; // too fine — grow the parameter step
    }

    pushSeg();
    return segments;
}
