/**
 * geoview — Polynomial fitting (GeoGebra `FitPoly` command).
 *
 * GeoGebra's `FitPoly[<list of points>, <degree>]` returns the least-squares
 * polynomial of the given degree through the points. The single-argument form
 * `FitPoly[<list>]` (as in geogebra-export.ggb) is treated as an exact
 * interpolation with degree = pointCount − 1.
 *
 * The fit is recomputed at runtime (GeoGebra stores only the recipe — a
 * `<command>` whose output is an `<element type="function">` with no stored
 * expression), so dragging a fit point must re-shape the curve.
 *
 * Solves the Vandermonde system via mathjs:
 *  - degree = n−1  → square system, exact interpolation (lusolve).
 *  - degree < n−1  → rectangular, least-squares via normal equations
 *    (VᵀV) c = Vᵀy.
 */

import { lusolve, matrix } from "mathjs";

/** A 2D point used as fit input. */
export interface FitPoint {
    x: number;
    y: number;
}

/** Result of a polynomial fit. Coefficients are ascending: c0 + c1*x + ... + cN*x^N. */
export interface FitResult {
    /** Ascending coefficients [c0, c1, ..., cN]. */
    coefficients: number[];
    /** Evaluate the polynomial at x. */
    evaluate: (x: number) => number;
    /** Canonical GeoGebra-style expression string, e.g. "1 + 2 x + 3 x^2". */
    expression: string;
}

/**
 * Fit a polynomial of the given degree to the points.
 *
 * @param points  fit data (must be non-empty)
 * @param degree  polynomial degree; clamped to [0, n−1]
 * @returns the fitted polynomial
 */
export function fitPoly(points: FitPoint[], degree: number): FitResult {
    const n = points.length;
    if (n === 0) {
        return { coefficients: [], evaluate: () => NaN, expression: "0" };
    }

    const deg = Math.max(0, Math.min(degree, n - 1));
    const cols = deg + 1;

    // Vandermonde matrix V[i][j] = x_i^j  (n × cols)
    const V: number[][] = points.map((p) => {
        const row = new Array<number>(cols);
        let xj = 1;
        for (let j = 0; j < cols; j++) {
            row[j] = xj;
            xj *= p.x;
        }
        return row;
    });
    const y = points.map((p) => p.y);

    // Solve. Square (deg = n−1) → direct lusolve on the Vandermonde matrix.
    // Rectangular (deg < n−1) → least-squares via normal equations
    // (VᵀV) c = Vᵀy, computed as plain arrays to sidestep mathjs' awkward
    // matrix-result typing.
    let coeffs: number[];
    if (deg === n - 1) {
        coeffs = toCoeffs(lusolve(matrix(V), y));
    } else {
        const VtV: number[][] = Array.from({ length: cols }, () => new Array<number>(cols));
        const Vty: number[] = new Array<number>(cols);
        for (let j = 0; j < cols; j++) {
            for (let k = 0; k < cols; k++) {
                let v = 0;
                for (let i = 0; i < n; i++) v += V[i][j] * V[i][k];
                VtV[j][k] = v;
            }
            let s = 0;
            for (let i = 0; i < n; i++) s += V[i][j] * y[i];
            Vty[j] = s;
        }
        coeffs = toCoeffs(lusolve(VtV, Vty));
    }

    return {
        coefficients: coeffs,
        evaluate: (x: number): number => {
            // Horner's method for numerical stability.
            let acc = coeffs[cols - 1];
            for (let j = cols - 2; j >= 0; j--) {
                acc = acc * x + coeffs[j];
            }
            return acc;
        },
        expression: polyExpression(coeffs)
    };
}

/**
 * Extract ascending coefficients [c0, c1, ..., cN] from a mathjs solve
 * result, which comes back as a nested column vector (DenseMatrix with
 * `.toArray()`, or a plain `[[c0],[c1],...]` array).
 */
function toCoeffs(sol: unknown): number[] {
    const arr: unknown =
        sol && typeof (sol as { toArray?: () => unknown }).toArray === "function"
            ? (sol as { toArray: () => unknown }).toArray()
            : sol;
    return (arr as unknown[]).map((row) =>
        Array.isArray(row) ? (row[0] as number) : (row as number)
    );
}

/**
 * Build a canonical GeoGebra-style expression string from ascending
 * coefficients, for the sampler/renderer (which re-sample it like any
 * `f(x) = ...` function). Skips near-zero terms.
 */
function polyExpression(coeffs: number[]): string {
    const terms: string[] = [];
    for (let i = coeffs.length - 1; i >= 0; i--) {
        const c = coeffs[i];
        if (Math.abs(c) < 1e-12) continue;
        const sign = c < 0 ? "-" : "+";
        const mag = Math.abs(c);
        // degree-0 term is the constant; degree-1 is "x"; higher is "x^n"
        let body: string;
        if (i === 0) body = formatCoeff(mag);
        else if (i === 1) body = `${formatCoeff(mag)} x`;
        else body = `${formatCoeff(mag)} x^${i}`;

        if (terms.length === 0) {
            terms.push(c < 0 ? `-${body}` : body);
        } else {
            terms.push(`${sign} ${body}`);
        }
    }
    return terms.length ? terms.join(" ") : "0";
}

/** Format a coefficient, dropping a trailing 1 before "x". */
function formatCoeff(c: number): string {
    // Keep full precision; the sampler re-parses with mathjs.
    return String(c);
}
