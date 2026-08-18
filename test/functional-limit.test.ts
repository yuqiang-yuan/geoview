/**
 * functional-limit-1.ggb tests.
 *
 * This fixture demonstrates lim_{x→1} (x³-1)/(x-1) = 3. Dragging the slider α
 * sweeps point A = (α, (α³-1)/(α-1)) along the curve while the function
 * f(t) = If[-2 ≤ t ≤ α, (t³-1)/(t-1)] draws progressively up to α — the
 * "arc trajectory" effect. These tests pin the two fixes that make it render:
 *
 * 1. The sampler must carry external slider values (α) as scope AND recognise
 *    the function's own variable name (t, not just x). Without these f samples
 *    as all-NaN and the curve is empty.
 * 2. The visibility condition `α ≟ 1` (U+225F) must translate to `==`, else
 *    A' (the limit marker) is always visible and overlaps A.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, compileExpression, builtinSampler } from "../src/index";
import { Kernel } from "../src/kernel";
import { buildScene } from "../src/scene-builder";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/functional-limit-1.ggb"));
const doc = parseGgb(data);

describe("kernel - functional-limit-1 point A", () => {
    const kernel = new Kernel(doc);

    it("resolves α as a free number = -2", () => {
        const v = kernel.getValue("α");
        expect(v?.kind).toBe("number");
        if (v?.kind === "number") expect(v.value).toBe(-2);
    });

    it("resolves A = (α, (α³-1)/(α-1)) at α=0.5 → (0.5, 1.75)", () => {
        kernel.setValue("α", { kind: "number", value: 0.5 });
        const a = kernel.getValue("A");
        expect(a?.kind).toBe("point");
        if (a?.kind !== "point") return;
        expect(a.x).toBeCloseTo(0.5, 6);
        expect(a.y).toBeCloseTo(1.75, 6);
    });

    it("A is undefined at α=1 (0/0 hole)", () => {
        kernel.setValue("α", { kind: "number", value: 1 });
        expect(kernel.getValue("A")).toBeUndefined();
    });

    it("resolves A' = (α, α²+α+1) at α=1 → (1, 3) the limit value", () => {
        kernel.setValue("α", { kind: "number", value: 1 });
        const ap = kernel.getValue("A'");
        expect(ap?.kind).toBe("point");
        if (ap?.kind !== "point") return;
        expect(ap.x).toBeCloseTo(1, 6);
        expect(ap.y).toBeCloseTo(3, 6);
    });

    it("f is a function value", () => {
        expect(kernel.getValue("f")?.kind).toBe("function");
    });
});

describe("kernel - ≟ visibility condition", () => {
    const kernel = new Kernel(doc);

    it("α ≟ 1 is false at α=0.5", () => {
        kernel.setValue("α", { kind: "number", value: 0.5 });
        expect(kernel.evalCondition("α ≟ 1")).toBe(false);
    });

    it("α ≟ 1 is true at α=1", () => {
        kernel.setValue("α", { kind: "number", value: 1 });
        expect(kernel.evalCondition("α ≟ 1")).toBe(true);
    });

    it("α ≥ 1 gates the limit segments", () => {
        kernel.setValue("α", { kind: "number", value: 0.5 });
        expect(kernel.evalCondition("α ≥ 1")).toBe(false);
        kernel.setValue("α", { kind: "number", value: 1 });
        expect(kernel.evalCondition("α ≥ 1")).toBe(true);
    });
});

describe("scene - progressive curve f and A' visibility", () => {
    it("A' is hidden at α=0.5 (cond α ≟ 1 false)", () => {
        const kernel = new Kernel(doc);
        kernel.setValue("α", { kind: "number", value: 0.5 });
        const sc = buildScene(doc, { width: 800, height: 600, kernel });
        const ap = sc.renderables.find((r) => r.label === "A'");
        expect(ap).toBeDefined();
        expect((ap as { visible?: boolean }).visible).toBe(false);
    });

    it("f renderable carries the live α scope", () => {
        const kernel = new Kernel(doc);
        kernel.setValue("α", { kind: "number", value: 0.5 });
        const sc = buildScene(doc, { width: 800, height: 600, kernel });
        const f = sc.renderables.find((r) => r.kind === "function") as
            | { scope?: Record<string, number> } | undefined;
        expect(f?.scope?.α).toBeCloseTo(0.5, 6);
    });

    it("f samples only up to α (curve truncates at the slider)", () => {
        const kernel = new Kernel(doc);
        const sampleMaxX = (alpha: number): number => {
            kernel.setValue("α", { kind: "number", value: alpha });
            const sc = buildScene(doc, { width: 800, height: 600, kernel });
            const f = sc.renderables.find((r) => r.kind === "function") as
                | { expression: string; angleUnit: "degree" | "radian"; scope?: Record<string, number> }
                | undefined;
            if (!f) throw new Error("no f renderable");
            const res = builtinSampler(f.expression, {
                xRange: [-2, 2], yRange: [-5, 5], angleUnit: f.angleUnit,
                nSamples: 200, pixelWidth: 800, pixelHeight: 600, scope: f.scope
            });
            const pts = res.segments.flatMap((s) => s.points);
            return Math.max(...pts.map((p) => p.x));
        };
        expect(sampleMaxX(0.5)).toBeCloseTo(0.5, 1);
        expect(sampleMaxX(-1)).toBeCloseTo(-1, 1);
        expect(sampleMaxX(1.5)).toBeCloseTo(1.5, 1);
    });
});

describe("sampler - function variable + scope", () => {
    it("recognises a non-x function variable and honours scope bound", () => {
        const fn = compileExpression(
            "f(t) = If[-2 <= t <= α, (t^3 - 1) / (t - 1)]",
            "radian",
            { α: 0.5 }
        );
        expect(fn(0)).toBeCloseTo(1, 6);      // (0-1)/(0-1) = 1, within [-2, 0.5]
        expect(Number.isNaN(fn(1))).toBe(true); // t=1 > α=0.5 → NaN
    });

    it("regression: f(x) = sin(x) without scope still works", () => {
        const fn = compileExpression("f(x) = sin(x)");
        expect(fn(0)).toBeCloseTo(0, 6);
        expect(fn(Math.PI / 2)).toBeCloseTo(1, 6);
    });
});
