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

/** Sign of a number: -1, 0, or +1. */
function sgn(n: number): number {
    if (n > 0) return 1;
    if (n < 0) return -1;
    return 0;
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

    // Collect valid points. Reject NaN/Infinity, and also reject y values
    // outside the viewport range. Points near asymptotes with extreme y
    // values would otherwise create long vertical lines. We allow a small
    // margin beyond the viewport to avoid clipping legitimate steep curves.
    const yLo = yRange[0];
    const yHi = yRange[1];
    const ySpan = yHi - yLo;
    const rejectMin = yLo - ySpan * 0.5;
    const rejectMax = yHi + ySpan * 0.5;
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < nSamples; i++) {
        const x = xMin + step * i;
        const y = fn(x);
        if (
            typeof y === "number" &&
            !isNaN(y) &&
            isFinite(y) &&
            y >= rejectMin &&
            y <= rejectMax
        ) {
            points.push({ x, y });
        }
    }

    return splitDiscontinuities(points, fn, yRange);
}

/**
 * Recursively check whether the interval [d0, d1] contains a true
 * asymptote (y keeps going in the same direction) vs. a steep but
 * continuous curve (y direction reverses).
 *
 * @param d0    left point
 * @param d1    right point
 * @param fn    the function (for sub-sampling)
 * @param sign  the direction of y change we're checking
 * @param level recursion depth (default 3)
 * @returns refined boundary points + whether it's an asymptote
 */
interface AsymptoteCheck {
    asymptote: boolean;
    d0: { x: number; y: number };
    d1: { x: number; y: number };
}

function checkAsymptote(
    d0: { x: number; y: number },
    d1: { x: number; y: number },
    fn: (x: number) => number,
    sign: number,
    level: number
): AsymptoteCheck {
    if (level <= 0) {
        return { asymptote: true, d0, d1 };
    }

    const n = 10;
    const step = (d1.x - d0.x) / (n - 1);
    let prevX: number | undefined;
    let prevY: number | undefined;

    for (let i = 0; i < n; i++) {
        const x = d0.x + step * i;
        let y: number;
        try {
            y = fn(x);
        } catch {
            continue;
        }
        if (typeof y !== "number" || isNaN(y) || !isFinite(y)) continue;

        if (prevY !== undefined && prevX !== undefined) {
            const deltaY = y - prevY;
            const newSign = sgn(deltaY);
            // If the direction matches the asymptote sign, keep recursing
            if (newSign === sign) {
                return checkAsymptote(
                    { x: prevX, y: prevY },
                    { x, y },
                    fn,
                    sign,
                    level - 1
                );
            }
        }

        prevX = x;
        prevY = y;
    }

    return { asymptote: false, d0, d1 };
}

/**
 * Split a point array into continuous segments at discontinuities.
 *
 * Algorithm (zoom-independent):
 *
 * 1. Track the sign (direction) of y-change between consecutive points.
 * 2. When the sign reverses (e.g. y was going up, now goes down) AND
 *    the slope magnitude exceeds 1 (steeper than 45°), suspect an asymptote.
 * 3. Recursively sub-sample the interval to confirm:
 *    - If y keeps going in the same direction → true asymptote → split.
 *    - If y reverses direction → steep but continuous → don't split.
 * 4. Split points: the last point of the left segment and the first
 *    point of the right segment are clamped to avoid drawing to infinity.
 *
 * This approach doesn't depend on the viewport y-range, so it works
 * correctly at any zoom level.
 */
function splitDiscontinuities(
    points: Array<{ x: number; y: number }>,
    fn: (x: number) => number,
    yRange: [number, number]
): PolylineSegment[] {
    if (points.length < 2) {
        return points.length ? [{ points: [...points] }] : [];
    }

    const segments: PolylineSegment[] = [];
    let current: Array<{ x: number; y: number }> = [points[0]];
    let oldSign: number | undefined;
    let oldDeltaX = Infinity;

    for (let i = 1; i < points.length; i++) {
        const yOld = points[i - 1].y;
        const yNew = points[i].y;
        const deltaY = yNew - yOld;
        const newSign = sgn(deltaY);

        let isDiscontinuity = false;
        let skipCurrent = false;

        if (
            current.length >= 2 &&
            oldSign !== undefined &&
            oldSign !== 0 &&
            newSign !== 0 &&
            oldSign !== newSign &&
            Math.abs(deltaY / oldDeltaX) > 1
        ) {
            // Suspected asymptote — confirm with recursive sub-sampling
            const check = checkAsymptote(
                points[i - 1],
                points[i],
                fn,
                newSign,
                3
            );
            if (check.asymptote) {
                // Drop both boundary points — the curve near the asymptote
                // is inaccurate and would draw as a long vertical line.
                // The segment ends at the previous point (before points[i-1]),
                // the new segment starts at points[i+1] (next iteration).
                if (current.length > 1) {
                    current.pop();
                }
                isDiscontinuity = true;
                skipCurrent = true;
            }
        }

        if (isDiscontinuity) {
            if (current.length > 1) {
                segments.push({ points: current });
            }
            // Start fresh — don't include points[i] (skipCurrent)
            current = skipCurrent ? [] : [points[i]];
        } else {
            current.push(points[i]);
        }

        if (current.length > 1) {
            oldDeltaX = current[current.length - 1].x - current[current.length - 2].x;
            oldSign = newSign;
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
