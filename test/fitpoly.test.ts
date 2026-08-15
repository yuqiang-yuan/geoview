/**
 * Tests for the FitPoly (polynomial fit/interpolation) module.
 */
import { describe, it, expect } from "vitest";
import { fitPoly } from "../src/fitpoly";

describe("fitPoly", () => {
    it("interpolates exactly when degree = n−1", () => {
        // y = x^2 + 1 sampled at x = 1, 2, 3 → degree 2 = n−1 (interpolation)
        const pts = [
            { x: 1, y: 2 },
            { x: 2, y: 5 },
            { x: 3, y: 10 }
        ];
        const fit = fitPoly(pts, 2);
        expect(fit.evaluate(1)).toBeCloseTo(2, 10);
        expect(fit.evaluate(2)).toBeCloseTo(5, 10);
        expect(fit.evaluate(3)).toBeCloseTo(10, 10);
        // And at an intermediate point the underlying polynomial holds.
        expect(fit.evaluate(0)).toBeCloseTo(1, 10);
    });

    it("produces a sampler-friendly expression string", () => {
        const fit = fitPoly([{ x: 0, y: 1 }, { x: 1, y: 2 }], 1);
        // Linear through (0,1),(1,2): y = x + 1
        expect(fit.expression).toMatch(/x/);
        expect(fit.evaluate(0.5)).toBeCloseTo(1.5, 10);
    });

    it("least-squares fits when degree < n−1", () => {
        // Points roughly along y = 2x (with the line passing through origin-ish).
        const pts = [
            { x: 0, y: 0 },
            { x: 1, y: 2 },
            { x: 2, y: 4 },
            { x: 3, y: 6 }
        ];
        const fit = fitPoly(pts, 1); // degree 1, 4 points → least squares
        // The best-fit line is y = 2x exactly (zero residual).
        expect(fit.evaluate(1.5)).toBeCloseTo(3, 6);
        expect(fit.evaluate(2.5)).toBeCloseTo(5, 6);
    });

    it("clamps degree to [0, n−1]", () => {
        const pts = [{ x: 0, y: 5 }, { x: 1, y: 7 }];
        const fit = fitPoly(pts, 99); // degree clamped to 1
        expect(fit.evaluate(0)).toBeCloseTo(5, 10);
        expect(fit.evaluate(1)).toBeCloseTo(7, 10);
    });

    it("handles a single point as a constant", () => {
        const fit = fitPoly([{ x: 3, y: 9 }], 0);
        expect(fit.evaluate(3)).toBeCloseTo(9, 10);
        expect(fit.evaluate(100)).toBeCloseTo(9, 10);
    });
});
