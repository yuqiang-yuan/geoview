import { describe, it, expect } from "vitest";
import { compileExpression, sampleFunction } from "../src/index";
import type { SamplerParams } from "../src/index";

function params(overrides: Partial<SamplerParams> = {}): SamplerParams {
    return {
        xRange: [-4, 4],
        yRange: [-4, 4],
        angleUnit: "radian",
        nSamples: 800,
        pixelWidth: 800,
        pixelHeight: 800,
        ...overrides
    };
}

describe("real-branch power for negative bases", () => {
    it("evaluates the real cube root of negatives (not the complex branch)", () => {
        // GeoGebra: y = x^(1/3) is the real cube root: (-8)^(1/3) = -2.
        // mathjs's principal branch returns 1 + 1.73i, which would drop
        // the entire third quadrant.
        const fn = compileExpression("f(x) = x^(1 / 3)");
        expect(fn(-8)).toBeCloseTo(-2, 9);
        expect(fn(-1)).toBeCloseTo(-1, 9);
        expect(fn(-0.125)).toBeCloseTo(-0.5, 9);
        expect(fn(0)).toBe(0);
        expect(fn(8)).toBeCloseTo(2, 9);
    });

    it("keeps even-denominator roots of negatives undefined", () => {
        // (-8)^(1/2) has no real value -> NaN (matches GeoGebra).
        const fn = compileExpression("f(x) = x^(1 / 2)");
        expect(fn(-8)).toBeNaN();
        expect(fn(4)).toBeCloseTo(2, 9);
    });

    it("handles even-numerator rational exponents on negatives", () => {
        // (-8)^(2/3) = ((-8)^(1/3))^2 = (-2)^2 = 4.
        const fn = compileExpression("f(x) = x^(2 / 3)");
        expect(fn(-8)).toBeCloseTo(4, 9);
        expect(fn(8)).toBeCloseTo(4, 9);
    });

    it("renders the cube root in the third quadrant (x < 0, y < 0)", () => {
        const res = sampleFunction(
            compileExpression("f(x) = x^(1 / 3)"),
            params()
        );
        // Collect all rendered x coordinates that lie in x < 0.
        const negX = res.segments.flatMap((s) => s.points.filter((p) => p.x < -0.5));
        expect(negX.length).toBeGreaterThan(0);
        // Every sampled third-quadrant point is negative y (real branch).
        for (const p of negX) {
            expect(p.y).toBeLessThan(0);
        }
        // And the branch reaches a strongly negative value near x = -4.
        const minY = Math.min(...negX.map((p) => p.y));
        expect(minY).toBeLessThan(-1.5);
    });
});
