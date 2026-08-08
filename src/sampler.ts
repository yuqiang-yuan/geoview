/**
 * geoview — Function sampler.
 *
 * Evaluates GeoGebra function expressions using mathjs and produces
 * polyline segments, splitting at discontinuities (asymptotes, NaN).
 *
 * GeoGebra expressions look like "f(x) = sin(x)" — the expression to
 * the right of "=" is extracted and compiled with mathjs.
 *
 * Angle unit: GGB stores angleUnit in kernel settings. When "degree",
 * trig functions in the expression expect degrees. mathjs uses radians
 * by default, so we wrap degree-mode evaluation with appropriate conversion.
 */

import { compile as mathCompile, type EvalFunction } from "mathjs";
import type { PolylineSegment, SamplerFn, SamplerParams } from "./render-types";

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
 * Compile a GeoGebra expression into an evaluatable function.
 *
 * Note: GeoGebra's `angleUnit` setting affects angle-typed objects (e.g. 45°)
 * but NOT function expressions like `sin(x)`. In GeoGebra, `sin(x)` always
 * treats `x` as radians. We therefore pass `x` directly to mathjs without
 * degree→radian conversion.
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
    const rhs = extractExpression(expression);
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
            // mathjs may return a Complex or Unit — extract numeric value
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

/**
 * Sample a compiled function over [xMin, xMax], producing polyline segments.
 * Splits at discontinuities (NaN, Infinity, steep jumps).
 */
export function sampleFunction(
    fn: (x: number) => number,
    params: SamplerParams
): PolylineSegment[] {
    const { xRange, yRange, nSamples } = params;
    const [xMin, xMax] = xRange;
    const step = (xMax - xMin) / (nSamples - 1);

    // Collect valid points
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < nSamples; i++) {
        const x = xMin + step * i;
        const y = fn(x);
        if (typeof y === "number" && !isNaN(y) && isFinite(y)) {
            points.push({ x, y });
        }
    }

    return splitDiscontinuities(points, yRange);
}

/**
 * Split a point array into continuous segments at discontinuities.
 *
 * Detection: if the vertical jump |y2 - y1| between two adjacent
 * sample points exceeds a threshold based on the viewport y-range,
 * we assume there is an asymptote or discontinuity between them
 * and start a new segment.
 *
 * The threshold is set to 3× the viewport y-span. This catches
 * tan(x) near π/2 (where y shoots from large-positive to large-negative)
 * without falsely splitting sin/cos curves (which stay within [-1, 1]).
 */
function splitDiscontinuities(
    points: Array<{ x: number; y: number }>,
    yRange: [number, number]
): PolylineSegment[] {
    if (points.length < 2) {
        return points.length ? [{ points: [...points] }] : [];
    }

    const ySpan = Math.abs(yRange[1] - yRange[0]);
    const threshold = ySpan * 3;

    const segments: PolylineSegment[] = [];
    let current: Array<{ x: number; y: number }> = [points[0]];

    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const dy = Math.abs(curr.y - prev.y);

        if (dy > threshold) {
            // Discontinuity detected — start a new segment.
            // Don't include either point in the "jump" since both
            // are near the asymptote and thus inaccurate.
            if (current.length > 1) {
                segments.push({ points: current });
            }
            current = [curr];
        } else {
            current.push(curr);
        }
    }

    if (current.length > 1 || segments.length === 0) {
        segments.push({ points: current });
    }
    return segments;
}

/**
 * The built-in sampler implementation.
 * Takes a raw GGB expression string, compiles it, and samples.
 */
export const builtinSampler: SamplerFn = (
    expression: string,
    params: SamplerParams
): PolylineSegment[] => {
    const fn = compileExpression(expression, params.angleUnit);
    return sampleFunction(fn, params);
};
