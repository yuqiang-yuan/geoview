/**
 * differentiable-tangent.ggb — real-branch power in the kernel.
 *
 * f(x) = x^(1/3), point A = (a, f(a)), and g = Tangent[f, A]. For a < 0 the
 * cube root must take the real branch (e.g. (-8)^(1/3) = -2) rather than the
 * complex principal branch, otherwise A evaluates to NaN and the tangent
 * breaks. This locks the kernel-side fix (sampler.compileMath) in place.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb } from "../src/index";
import { Kernel } from "../src/kernel";

const data = readFileSync(
    resolve(import.meta.dirname, "fixtures/differentiable-tangent.ggb")
);
const kernel = new Kernel(parseGgb(data));

describe("kernel - differentiable-tangent.ggb real-branch power", () => {
    it("f is the real cube root for negative x", () => {
        const f = kernel.getValue("f");
        expect(f?.kind).toBe("function");
        if (f?.kind === "function") {
            expect(f.evaluate(-8)).toBeCloseTo(-2, 9);
            expect(f.evaluate(-1)).toBeCloseTo(-1, 9);
            expect(f.evaluate(8)).toBeCloseTo(2, 9);
        }
    });

    it("point A = (a, f(a)) evaluates to a real point for negative a", () => {
        kernel.setValue("a", { kind: "number", value: -8 });
        const a = kernel.getValue("a");
        const A = kernel.getValue("A");
        expect(a?.kind).toBe("number");
        if (a?.kind === "number") expect(a.value).toBe(-8);
        expect(A?.kind).toBe("point");
        if (A?.kind === "point") {
            expect(A.x).toBeCloseTo(-8, 9);
            expect(A.y).toBeCloseTo(-2, 9);
        }
    });

    it("A tracks the slider across the whole -4..4 range (no NaN at negatives)", () => {
        for (const av of [-4, -3.7, -2.4, -0.5, 0, 0.5, 3.9, 4]) {
            kernel.setValue("a", { kind: "number", value: av });
            const A = kernel.getValue("A");
            expect(A?.kind).toBe("point");
            if (A?.kind === "point") {
                expect(Number.isFinite(A.x)).toBe(true);
                expect(Number.isFinite(A.y)).toBe(true);
                expect(A.x).toBeCloseTo(av, 9);
                // f(a) = sign(a) * |a|^(1/3)
                const expected = Math.sign(av) * Math.pow(Math.abs(av), 1 / 3);
                expect(A.y).toBeCloseTo(expected, 6);
            }
        }
    });
});
