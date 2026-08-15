/**
 * geoview - Conic classification and sampling.
 *
 * GeoGebra stores every conic (circle, ellipse, parabola, hyperbola) as a
 * symmetric 3x3 homogeneous matrix in <matrix A0..A5>, laid out as
 *
 *      M = [[A0, A3, A4],
 *           [A3, A1, A5],
 *           [A4, A5, A2]]
 *
 * which encodes the quadratic equation
 *
 *      A0*x^2 + 2*A3*x*y + A1*y^2 + 2*A4*x + 2*A5*y + A2 = 0
 *
 * (verified against GeoGebra's GeoConic.java internal matrix layout:
 * the XML A0..A5 attributes are its matrix[0..5] verbatim).
 *
 * This module converts that matrix into full quadratic coefficients
 * a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0, classifies the conic from
 * its invariants, and produces polyline segments by parametrising in the
 * eigenframe of the quadratic part. Sampling is pixel-space adaptive so
 * behaviour is zoom-independent (same strategy as the function sampler).
 *
 * The <eigenvectors> XML element is only an orientation hint GeoGebra uses
 * to keep eigenvector directions stable across load/save cycles - we
 * recompute the eigen-decomposition ourselves and ignore it.
 */

import type { GgbConicMatrix } from "./types";
import type { PolylineSegment } from "./render-types";

// ============================================================
// Types
// ============================================================

/** Full quadratic coefficients: a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0 */
export interface ConicCoefficients {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export type ConicType =
    | "circle"
    | "ellipse"
    | "parabola"
    | "hyperbola"
    | "degenerate";

export interface ConicSampleParams {
    /** Visible x range [xMin, xMax] */
    xRange: [number, number];
    /** Visible y range [yMin, yMax] */
    yRange: [number, number];
    /** Pixel width of the viewport (drives sampling density) */
    pixelWidth: number;
    /** Pixel height of the viewport (defaults to square pixels) */
    pixelHeight?: number;
}

/** Eigenframe of the quadratic part: R = [[cos,-sin],[sin,cos]] maps eigen -> world */
interface EigenFrame {
    cos: number;
    sin: number;
    /** Eigenvalue along the u-axis (world direction (cos, sin)) */
    lu: number;
    /** Eigenvalue along the v-axis (world direction (-sin, cos)) */
    lv: number;
}

// Pixel-space marching bounds (matching the function sampler's spirit:
// thresholds in pixels so behaviour is identical at any zoom level).
/** Accepted step between consecutive samples, upper bound in pixels. */
const MAX_STEP_PX = 3;
/** Steps finer than this grow geometrically. */
const MIN_STEP_PX = 1;
/** Per-arm march step cap (bounds worst-case work per render). */
const MAX_MARCH_STEPS = 6000;
/** Floor for the adaptive step to guarantee termination. */
const MIN_DT = 1e-12;
/** Tolerance for invariant-based classification (coeffs normalised to <=1). */
const CLASSIFY_EPS = 1e-9;
/** Minimum samples around a closed ellipse. */
const MIN_ELLIPSE_SAMPLES = 64;
/** Maximum samples around a closed ellipse. */
const MAX_ELLIPSE_SAMPLES = 4096;

// ============================================================
// Matrix -> coefficients
// ============================================================

/**
 * Convert GeoGebra's packed conic matrix into full quadratic coefficients.
 */
export function matrixToCoefficients(m: GgbConicMatrix): ConicCoefficients {
    return {
        a: m.A0,
        b: 2 * m.A3,
        c: m.A1,
        d: 2 * m.A4,
        e: 2 * m.A5,
        f: m.A2
    };
}

// ============================================================
// Classification
// ============================================================

/**
 * Classify a conic from its invariants.
 *
 * Uses the discriminant b^2 - 4ac and the determinant of the 3x3
 * homogeneous matrix:
 * - det3 = 0           -> degenerate (point, line pair, or empty)
 * - b^2 - 4ac = 0      -> parabola
 * - b^2 - 4ac < 0      -> ellipse (circle when a = c and b = 0)
 * - b^2 - 4ac > 0      -> hyperbola
 *
 * Coefficients are normalised first so the tolerance is scale-free.
 */
export function classifyConic(co: ConicCoefficients): ConicType {
    const norm = Math.max(
        Math.abs(co.a), Math.abs(co.b), Math.abs(co.c),
        Math.abs(co.d), Math.abs(co.e), Math.abs(co.f)
    );
    if (norm === 0) return "degenerate";

    const a = co.a / norm, b = co.b / norm, c = co.c / norm;
    const d = co.d / norm, e = co.e / norm, f = co.f / norm;

    // det of [[a, b/2, d/2], [b/2, c, e/2], [d/2, e/2, f]]
    const det3 =
        a * c * f
        - (a * e * e + b * b * f + c * d * d) / 4
        + b * d * e / 4;

    if (Math.abs(det3) < CLASSIFY_EPS) return "degenerate";

    const disc = b * b - 4 * a * c;
    if (Math.abs(disc) < CLASSIFY_EPS) return "parabola";
    if (disc < 0) {
        // Circle = ellipse with equal quadratic coefficients, no rotation
        if (Math.abs(a - c) < CLASSIFY_EPS && Math.abs(b) < CLASSIFY_EPS) {
            return "circle";
        }
        return "ellipse";
    }
    return "hyperbola";
}

// ============================================================
// Sampling
// ============================================================

/**
 * Sample a conic into polyline segments over the visible range.
 *
 * Returns one segment per connected visible arc:
 * - ellipse/circle: a single closed segment
 * - hyperbola: up to four half-branch arms
 * - parabola: two half-arcs from the vertex
 *
 * Degenerate and empty conics return [].
 */
export function sampleConic(
    co: ConicCoefficients,
    params: ConicSampleParams
): PolylineSegment[] {
    const type = classifyConic(co);
    if (type === "degenerate") return [];

    // Normalise so downstream arithmetic is scale-friendly
    const norm = Math.max(
        Math.abs(co.a), Math.abs(co.b), Math.abs(co.c),
        Math.abs(co.d), Math.abs(co.e), Math.abs(co.f)
    );
    const a = co.a / norm, b = co.b / norm, c = co.c / norm;
    const d = co.d / norm, e = co.e / norm, f = co.f / norm;

    const [xMin, xMax] = params.xRange;
    const [yMin, yMax] = params.yRange;
    const scaleX = params.pixelWidth / Math.max(xMax - xMin, 1e-12);
    const scaleY = params.pixelHeight !== undefined
        ? params.pixelHeight / Math.max(yMax - yMin, 1e-12)
        : scaleX;

    if (type === "ellipse" || type === "circle") {
        return sampleEllipse(a, b, c, d, e, f, xMin, xMax, yMin, yMax, scaleX, scaleY);
    }
    if (type === "hyperbola") {
        return sampleHyperbola(a, b, c, d, e, f, xMin, xMax, yMin, yMax, scaleX, scaleY);
    }
    return sampleParabola(a, b, c, d, e, f, xMin, xMax, yMin, yMax, scaleX, scaleY);
}

// ============================================================
// Eigen helpers
// ============================================================

/**
 * Diagonalise the quadratic form [[a, b/2], [b/2, c]].
 * The rotation R = [[cos,-sin],[sin,cos]] maps eigen coordinates (u, v)
 * to world coordinates; lu/lv are the eigenvalues along the u/v axes.
 */
function eigenDecompose(a: number, b: number, c: number): EigenFrame {
    // tan(2*theta) = b / (a - c); atan2 handles a == c
    const theta = 0.5 * Math.atan2(b, a - c);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const lu = a * cos * cos + b * sin * cos + c * sin * sin;
    const lv = a * sin * sin - b * sin * cos + c * cos * cos;
    return { cos, sin, lu, lv };
}

/** Map eigen coordinates (u, v) to world coordinates around (cx, cy). */
function toWorld(
    cx: number, cy: number, ef: EigenFrame, u: number, v: number
): { x: number; y: number } {
    return {
        x: cx + u * ef.cos - v * ef.sin,
        y: cy + u * ef.sin + v * ef.cos
    };
}

/**
 * Solve for the centre of a central conic: [2a b; b 2c] [x;y] = [-d; -e].
 * Requires 4ac - b^2 != 0 (true for ellipse/hyperbola).
 */
function solveCenter(
    a: number, b: number, c: number, d: number, e: number
): { x: number; y: number } {
    const det = 4 * a * c - b * b;
    return {
        x: (b * e - 2 * c * d) / det,
        y: (b * d - 2 * a * e) / det
    };
}

// ============================================================
// Adaptive marching (hyperbola arms / parabola half-arcs)
// ============================================================

/**
 * March a parametric curve from t0 in direction dir, keeping consecutive
 * samples between MIN_STEP_PX and MAX_STEP_PX apart (geometric step
 * growth/shrink). Stops when {@link exited} reports the curve has left
 * the region of interest (callers guarantee monotonic exit), or when the
 * step budget is exhausted.
 */
function march(
    fn: (t: number) => { x: number; y: number },
    t0: number,
    dir: 1 | -1,
    exited: (p: { x: number; y: number }) => boolean,
    scaleX: number,
    scaleY: number
): Array<{ x: number; y: number }> {
    const pts: Array<{ x: number; y: number }> = [];
    const first = fn(t0);
    pts.push(first);

    let t = t0;
    let dt = dir; // adapted down immediately by the first distance check
    let prev = first;

    for (let i = 0; i < MAX_MARCH_STEPS; i++) {
        const p = fn(t + dt);
        const dpx = Math.hypot((p.x - prev.x) * scaleX, (p.y - prev.y) * scaleY);

        if (dpx > MAX_STEP_PX && Math.abs(dt) > MIN_DT) {
            dt /= 2;
            continue; // reject the step, retry smaller
        }

        t += dt;
        prev = p;
        pts.push(p);

        if (exited(p)) break;
        if (dpx < MIN_STEP_PX) dt *= 2;
    }

    return pts;
}

/** Viewport rect in eigenframe coordinates: axis-aligned bounding box. */
function eigenBounds(
    ef: EigenFrame,
    cx: number, cy: number,
    xMin: number, xMax: number,
    yMin: number, yMax: number,
    scaleX: number, scaleY: number
): { uMax: number; vMax: number } {
    // Padding: a couple of pixels in world units on each axis
    const padX = 2 / scaleX + 2 / scaleY;
    const padY = padX;
    const corners: Array<[number, number]> = [
        [xMin - padX, yMin - padY],
        [xMax + padX, yMin - padY],
        [xMin - padX, yMax + padY],
        [xMax + padX, yMax + padY]
    ];
    let uMax = 0;
    let vMax = 0;
    for (const [x, y] of corners) {
        const dx = x - cx;
        const dy = y - cy;
        const u = dx * ef.cos + dy * ef.sin;
        const v = -dx * ef.sin + dy * ef.cos;
        uMax = Math.max(uMax, Math.abs(u));
        vMax = Math.max(vMax, Math.abs(v));
    }
    return { uMax, vMax };
}

// ============================================================
// Per-type samplers
// ============================================================

function sampleEllipse(
    a: number, b: number, c: number, d: number, e: number, f: number,
    xMin: number, xMax: number, yMin: number, yMax: number,
    scaleX: number, scaleY: number
): PolylineSegment[] {
    const ef = eigenDecompose(a, b, c);
    const center = solveCenter(a, b, c, d, e);
    // Q(center) = f + (d*x0 + e*y0)/2  (from the gradient equations)
    const f0 = f + (d * center.x + e * center.y) / 2;

    // Semiaxes; opposite signs of (f0, lambda) -> empty conic
    const r1sq = -f0 / ef.lu;
    const r2sq = -f0 / ef.lv;
    if (r1sq <= 0 || r2sq <= 0) return [];
    const r1 = Math.sqrt(r1sq);
    const r2 = Math.sqrt(r2sq);

    // Off-screen check: world AABB of the rotated ellipse
    const ex = r1 * Math.abs(ef.cos) + r2 * Math.abs(ef.sin);
    const ey = r1 * Math.abs(ef.sin) + r2 * Math.abs(ef.cos);
    if (
        center.x + ex < xMin || center.x - ex > xMax ||
        center.y + ey < yMin || center.y - ey > yMax
    ) {
        return [];
    }

    // ~2px per segment around the perimeter
    const scale = Math.max(scaleX, scaleY);
    const n = Math.min(
        MAX_ELLIPSE_SAMPLES,
        Math.max(MIN_ELLIPSE_SAMPLES, Math.round(Math.PI * (r1 + r2) * scale / 2))
    );

    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= n; i++) {
        const t = (2 * Math.PI * i) / n;
        const p = toWorld(center.x, center.y, ef, r1 * Math.cos(t), r2 * Math.sin(t));
        points.push(p);
    }
    return [{ points }];
}

function sampleHyperbola(
    a: number, b: number, c: number, d: number, e: number, f: number,
    xMin: number, xMax: number, yMin: number, yMax: number,
    scaleX: number, scaleY: number
): PolylineSegment[] {
    let ef = eigenDecompose(a, b, c);
    const center = solveCenter(a, b, c, d, e);
    // Q(center) = f + (d*x0 + e*y0)/2  (from the gradient equations)
    const f0 = f + (d * center.x + e * center.y) / 2;

    // Ensure the u-axis is the transverse axis: u^2/a^2 - v^2/b^2 = 1
    // (rotate the eigenframe by 90 degrees if needed)
    if (-f0 / ef.lu < 0 && -f0 / ef.lv > 0) {
        ef = { cos: ef.sin, sin: -ef.cos, lu: ef.lv, lv: ef.lu };
    }

    const A = Math.sqrt(Math.abs(f0 / ef.lu)); // transverse semiaxis
    const B = Math.sqrt(Math.abs(f0 / ef.lv)); // conjugate semiaxis
    if (!Number.isFinite(A) || !Number.isFinite(B) || A === 0) return [];

    const { uMax, vMax } = eigenBounds(
        ef, center.x, center.y, xMin, xMax, yMin, yMax, scaleX, scaleY
    );

    const segments: PolylineSegment[] = [];

    // Four half-branches: (u, v) = (±A cosh t, ±B sinh t), t >= 0.
    // |u| and |v| are monotone in t, so once a point leaves the eigenframe
    // AABB of the viewport it never returns - safe march termination.
    for (const su of [1, -1] as const) {
        for (const sv of [1, -1] as const) {
            const pts = march(
                (t) => {
                    const u = su * A * Math.cosh(Math.min(t, 700)); // cosh overflows > ~710
                    const v = sv * B * Math.sinh(Math.min(t, 700));
                    return toWorld(center.x, center.y, ef, u, v);
                },
                0,
                1,
                (p) => {
                    const dx = p.x - center.x;
                    const dy = p.y - center.y;
                    const u = dx * ef.cos + dy * ef.sin;
                    const v = -dx * ef.sin + dy * ef.cos;
                    return Math.abs(u) > uMax || Math.abs(v) > vMax;
                },
                scaleX,
                scaleY
            );
            if (pts.length >= 2) {
                segments.push({ points: pts });
            }
        }
    }

    return segments;
}

function sampleParabola(
    a: number, b: number, c: number, d: number, e: number, f: number,
    xMin: number, xMax: number, yMin: number, yMax: number,
    scaleX: number, scaleY: number
): PolylineSegment[] {
    const ef = eigenDecompose(a, b, c);

    // One eigenvalue is ~0 (free axis), the other is the quadratic axis.
    // Orient the frame so u = free axis, v = quadratic axis.
    let cosF = ef.cos, sinF = ef.sin;      // free axis direction
    let cosQ = -ef.sin, sinQ = ef.cos;     // quadratic axis direction
    let lambda = ef.lv;
    if (Math.abs(ef.lu) > Math.abs(ef.lv)) {
        cosF = -ef.sin; sinF = ef.cos;
        cosQ = ef.cos; sinQ = ef.sin;
        lambda = ef.lu;
    }
    if (Math.abs(lambda) < CLASSIFY_EPS) return [];

    // Linear coefficients in eigenframe coordinates (s = free, w = quadratic):
    // Q(s, w) = lambda*w^2 + alpha*s + beta*w + f
    const alpha = d * cosF + e * sinF;
    const beta = d * cosQ + e * sinQ;
    if (Math.abs(alpha) < CLASSIFY_EPS) return []; // degenerate (parallel lines)

    // Complete the square: s(w) = s0 - (lambda/alpha) * (w - w0)^2
    const w0 = -beta / (2 * lambda);
    const s0 = -(f - (beta * beta) / (4 * lambda)) / alpha;
    const k = lambda / alpha;

    const toWorldPw = (s: number, w: number): { x: number; y: number } => ({
        x: s * cosF + w * cosQ,
        y: s * sinF + w * sinQ
    });

    // Visible bounds in eigenframe (AABB of the rotated viewport rect,
    // relative to the vertex; |s - s0| and |w - w0| are monotone along
    // each half-arc, so exceeding these bounds means the arc has left).
    const pad = 2 / scaleX + 2 / scaleY;
    const corners: Array<[number, number]> = [
        [xMin - pad, yMin - pad],
        [xMax + pad, yMin - pad],
        [xMin - pad, yMax + pad],
        [xMax + pad, yMax + pad]
    ];
    let sAbsMax = 0;
    let wAbsMax = 0;
    for (const [x, y] of corners) {
        sAbsMax = Math.max(sAbsMax, Math.abs(x * cosF + y * sinF - s0));
        wAbsMax = Math.max(wAbsMax, Math.abs(x * cosQ + y * sinQ - w0));
    }

    const segments: PolylineSegment[] = [];
    for (const dir of [1, -1] as const) {
        const pts = march(
            (w) => toWorldPw(s0 - k * (w - w0) * (w - w0), w),
            w0,
            dir,
            (p) => {
                const s = p.x * cosF + p.y * sinF;
                const w = p.x * cosQ + p.y * sinQ;
                return Math.abs(s - s0) > sAbsMax || Math.abs(w - w0) > wAbsMax;
            },
            scaleX,
            scaleY
        );
        if (pts.length >= 2) {
            segments.push({ points: pts });
        }
    }

    // Off-screen parabola: both half-arcs start outside the viewport.
    // Keep them anyway - the renderer clips to the canvas, and marginally
    // visible arcs cost at most a few hundred samples.
    return segments;
}
