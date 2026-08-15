/**
 * Conic classification and sampling tests.
 *
 * Matrices are constructed from known equations (coefficients of
 * a*x^2 + b*x*y + c*y^2 + d*x + e*y + f = 0) plus one real matrix
 * from exp.ggb (verified to be y = x^2).
 */
import { describe, it, expect } from "vitest";
import {
    classifyConic,
    sampleConic,
    matrixToCoefficients,
    type ConicCoefficients,
    type ConicSampleParams
} from "../src/index";

/** Evaluate a*x^2 + b*x*y + c*y^2 + d*x + e*y + f at a point. */
function evalQ(co: ConicCoefficients, x: number, y: number): number {
    return co.a * x * x + co.b * x * y + co.c * y * y + co.d * x + co.e * y + co.f;
}

/** Viewport: 800x600 px over [-5, 5] x [-4, 4] (100 px per unit, square). */
function params(overrides: Partial<ConicSampleParams> = {}): ConicSampleParams {
    return {
        xRange: [-5, 5],
        yRange: [-4, 4],
        pixelWidth: 800,
        pixelHeight: 600,
        ...overrides
    };
}

describe("classifyConic", () => {
    it("classifies standard forms", () => {
        // x^2 + y^2 - 4 = 0: circle radius 2
        expect(classifyConic({ a: 1, b: 0, c: 1, d: 0, e: 0, f: -4 })).toBe("circle");
        // x^2/4 + y^2 - 1 = 0: ellipse
        expect(classifyConic({ a: 0.25, b: 0, c: 1, d: 0, e: 0, f: -1 })).toBe("ellipse");
        // x^2 - y^2 - 1 = 0: hyperbola
        expect(classifyConic({ a: 1, b: 0, c: -1, d: 0, e: 0, f: -1 })).toBe("hyperbola");
        // y - x^2 = 0: parabola
        expect(classifyConic({ a: -1, b: 0, c: 0, d: 0, e: 1, f: 0 })).toBe("parabola");
    });

    it("classifies degenerate conics", () => {
        // x^2 + y^2 = 0: single point (0, 0)
        expect(classifyConic({ a: 1, b: 0, c: 1, d: 0, e: 0, f: 0 })).toBe("degenerate");
        // x^2 - 1 = 0: parallel lines x = ±1
        expect(classifyConic({ a: 1, b: 0, c: 0, d: 0, e: 0, f: -1 })).toBe("degenerate");
        // all zeros
        expect(classifyConic({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBe("degenerate");
    });

    it("classifies the exp.ggb matrix as a parabola", () => {
        // <matrix A0="-1" A1="0" A2="0" A3="0" A4="0" A5="0.5"/>
        const co = matrixToCoefficients({
            A0: -1, A1: 0, A2: 0, A3: 0, A4: 0, A5: 0.5
        });
        expect(classifyConic(co)).toBe("parabola");
    });
});

describe("sampleConic - circle/ellipse", () => {
    it("samples a full circle that satisfies the equation", () => {
        const co = { a: 1, b: 0, c: 1, d: 0, e: 0, f: -4 };
        const segs = sampleConic(co, params());
        expect(segs).toHaveLength(1);
        const pts = segs[0].points;
        expect(pts.length).toBeGreaterThan(32);
        // Every point on the curve, equation ~ 0
        for (const p of pts) {
            expect(evalQ(co, p.x, p.y)).toBeCloseTo(0, 6);
        }
        // Closed: first and last point coincide
        const first = pts[0];
        const last = pts[pts.length - 1];
        expect(first.x).toBeCloseTo(last.x, 6);
        expect(first.y).toBeCloseTo(last.y, 6);
    });

    it("translates and scales correctly (off-center ellipse)", () => {
        // (x-1)^2/4 + (y+2)^2 = 1 -> 0.25(x-1)^2 + (y+2)^2 - 1 = 0
        const co = {
            a: 0.25, b: 0, c: 1,
            d: -0.5, e: 4, f: 0.25 + 4 - 1
        };
        const segs = sampleConic(co, params({ yRange: [-4.5, 0.5] }));
        expect(segs).toHaveLength(1);
        for (const p of segs[0].points) {
            expect(evalQ(co, p.x, p.y)).toBeCloseTo(0, 6);
        }
        // Extent: x in [-1, 3], y in [-3, -1] (parametric sampling may
        // miss the exact extremes by a small margin)
        const xs = segs[0].points.map((p) => p.x);
        const ys = segs[0].points.map((p) => p.y);
        expect(Math.min(...xs)).toBeLessThanOrEqual(-1 + 1e-3);
        expect(Math.max(...xs)).toBeGreaterThanOrEqual(3 - 1e-3);
        expect(Math.min(...ys)).toBeLessThanOrEqual(-3 + 1e-3);
        expect(Math.max(...ys)).toBeGreaterThanOrEqual(-1 - 1e-3);
    });

    it("returns nothing for an off-screen circle", () => {
        // Circle centered at (100, 100)
        const co = { a: 1, b: 0, c: 1, d: -200, e: -200, f: 10000 + 10000 - 4 };
        expect(sampleConic(co, params())).toHaveLength(0);
    });

    it("samples a rotated ellipse", () => {
        // Rotate x^2/4 + y^2 - 1 = 0 by 30 degrees: substitute
        // x = u cos30 - v sin30, y = u sin30 + v cos30 into u^2/4 + v^2 - 1
        const t = Math.PI / 6;
        const ct = Math.cos(t), st = Math.sin(t);
        // Q(u,v) = (u ct - v st)^2/4 + (u st + v ct)^2 - 1
        const a = ct * ct / 4 + st * st;
        const b = 2 * (-ct * st / 4 + st * ct); // full xy coefficient
        const c = st * st / 4 + ct * ct;
        const co = { a, b, c, d: 0, e: 0, f: -1 };
        expect(classifyConic(co)).toBe("ellipse");
        const segs = sampleConic(co, params());
        expect(segs).toHaveLength(1);
        for (const p of segs[0].points) {
            expect(evalQ(co, p.x, p.y)).toBeCloseTo(0, 6);
        }
    });
});

describe("sampleConic - hyperbola", () => {
    it("samples x^2 - y^2 = 1 as four arms satisfying the equation", () => {
        const co = { a: 1, b: 0, c: -1, d: 0, e: 0, f: -1 };
        const segs = sampleConic(co, params());
        expect(segs.length).toBeGreaterThanOrEqual(2);
        for (const seg of segs) {
            expect(seg.points.length).toBeGreaterThan(2);
            for (const p of seg.points) {
                expect(evalQ(co, p.x, p.y)).toBeCloseTo(0, 6);
            }
        }
        // Arms cover the vertices (±1, 0)
        const all = segs.flatMap((s) => s.points);
        const minX = Math.min(...all.map((p) => p.x));
        const maxX = Math.max(...all.map((p) => p.x));
        expect(minX).toBeLessThanOrEqual(-1 + 1e-6);
        expect(maxX).toBeGreaterThanOrEqual(1 - 1e-6);
        // Sampled points stay within the (padded) viewport bounds
        for (const p of all) {
            expect(p.x).toBeGreaterThanOrEqual(-5.2);
            expect(p.x).toBeLessThanOrEqual(5.2);
            expect(p.y).toBeGreaterThanOrEqual(-4.2);
            expect(p.y).toBeLessThanOrEqual(4.2);
        }
    });

    it("samples a rotated hyperbola (transverse on y)", () => {
        // y^2 - x^2 = 1
        const co = { a: -1, b: 0, c: 1, d: 0, e: 0, f: -1 };
        const segs = sampleConic(co, params());
        expect(segs.length).toBeGreaterThanOrEqual(2);
        const all = segs.flatMap((s) => s.points);
        for (const p of all) {
            expect(evalQ(co, p.x, p.y)).toBeCloseTo(0, 6);
        }
        const minY = Math.min(...all.map((p) => p.y));
        const maxY = Math.max(...all.map((p) => p.y));
        expect(minY).toBeLessThanOrEqual(-1 + 1e-6);
        expect(maxY).toBeGreaterThanOrEqual(1 - 1e-6);
    });
});

describe("sampleConic - parabola", () => {
    it("samples the exp.ggb matrix (y = x^2) as two arcs through the vertex", () => {
        const co = matrixToCoefficients({ A0: -1, A1: 0, A2: 0, A3: 0, A4: 0, A5: 0.5 });
        const segs = sampleConic(co, params());
        expect(segs).toHaveLength(2);

        for (const seg of segs) {
            for (const p of seg.points) {
                // y = x^2 (up to sampling precision)
                expect(p.y).toBeCloseTo(p.x * p.x, 6);
            }
        }

        // Together the arcs span the viewport x range and pass the vertex
        const all = segs.flatMap((s) => s.points);
        const minX = Math.min(...all.map((p) => p.x));
        const maxX = Math.max(...all.map((p) => p.x));
        expect(minX).toBeLessThanOrEqual(-2); // y=4 at x=±2 is the view top edge
        expect(maxX).toBeGreaterThanOrEqual(2);
        // Vertex (0, 0) is the first point of both half-arcs
        for (const seg of segs) {
            expect(seg.points[0].x).toBeCloseTo(0, 6);
            expect(seg.points[0].y).toBeCloseTo(0, 6);
        }
    });

    it("samples a horizontal parabola x = y^2", () => {
        const co = { a: 0, b: 0, c: -1, d: 1, e: 0, f: 0 };
        expect(classifyConic(co)).toBe("parabola");
        const segs = sampleConic(co, params());
        expect(segs).toHaveLength(2);
        for (const seg of segs) {
            for (const p of seg.points) {
                expect(p.x).toBeCloseTo(p.y * p.y, 6);
            }
        }
    });
});
