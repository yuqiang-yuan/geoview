/**
 * Integration tests with geogebra-export.ggb — FitPoly + slider δ.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, buildScene } from "../src/index";
import { Kernel } from "../src/kernel";
import type { RenderableFunction, RenderableSlider, RenderableText } from "../src/render-types";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/geogebra-export.ggb"));
const doc = parseGgb(data);
const kernel = new Kernel(doc);
const scene = buildScene(doc, { width: 800, height: 600, kernel });

describe("geogebra-export.ggb - FitPoly + slider", () => {
    it("renders the FitPoly output f as a function renderable", () => {
        const f = scene.renderables.find((r) => r.label === "f");
        expect(f?.kind).toBe("function");
        const fn = f as RenderableFunction;
        // Expression is a polynomial (interpolation, degree 4) — not empty.
        expect(fn.expression.length).toBeGreaterThan(0);
        expect(fn.expression).toMatch(/x\^4/);
    });

    it("renders the slider δ", () => {
        const d = scene.renderables.find((r) => r.label === "δ");
        expect(d?.kind).toBe("slider");
        const sl = d as RenderableSlider;
        expect(sl.min).toBe(0);
        expect(sl.max).toBeCloseTo(0.5, 6);
        expect(sl.value).toBe(0);
    });

    it("hides δ-gated objects at δ=0 (condition δ ≠ 0)", () => {
        const labels = scene.renderables.map((r) => `${r.label}:${r.visible}`);
        // N, G hidden when δ=0
        const n = scene.renderables.find((r) => r.label === "N");
        const g = scene.renderables.find((r) => r.label === "G");
        expect(n?.visible).toBe(false);
        expect(g?.visible).toBe(false);
        // condition-gated texts/segments hidden
        const text2 = scene.renderables.find((r) => r.label === "text2");
        expect(text2?.visible).toBe(false);
    });

    it("shows always-on objects at δ=0", () => {
        const m = scene.renderables.find((r) => r.label === "M");
        const j = scene.renderables.find((r) => r.label === "j"); // segment M-A, always on
        expect(m?.visible).toBe(true);
        expect(j?.visible).toBe(true);
        // A itself is <show object="false"> (intentionally hidden)
        const a = scene.renderables.find((r) => r.label === "A");
        expect(a?.visible).toBe(false);
    });

    it("re-evaluates visibility and coords when δ changes", () => {
        kernel.setValue("δ", { kind: "number", value: 0.2 });
        const scene2 = buildScene(doc, { width: 800, height: 600, kernel });
        const n = scene2.renderables.find((r) => r.label === "N");
        expect(n?.visible).toBe(true); // δ ≠ 0 now
        if (n?.kind === "point") {
            expect(n.x).toBeCloseTo(1.2, 6); // 1 + δ
        }
    });

    it("carries the slider's lineStyle thickness and opacity", () => {
        const d = scene.renderables.find((r) => r.label === "δ") as RenderableSlider;
        // <lineStyle thickness="10" ... opacity="100"/>
        expect(d.strokeWidth).toBe(10);
        expect(d.opacity).toBeCloseTo(100 / 255, 6);
    });

    it("exposes the kernel decimals setting for number rounding", () => {
        // <kernel><decimals val="2"/></kernel> drives tick/slider formatting.
        expect(scene.kernel?.decimals).toBe(2);
    });

    it("resolves text anchors from the kernel so labels track δ", () => {
        // text2 "x_0-δ" anchored at F - (0.1, 0.2); F = (1-δ, 0).
        // At δ=0.2 → x = 1 - 0.2 - 0.1 = 0.7.
        kernel.setValue("δ", { kind: "number", value: 0.2 });
        const scene2 = buildScene(doc, { width: 800, height: 600, kernel });
        const text2 = scene2.renderables.find((r) => r.label === "text2") as RenderableText;
        const text3 = scene2.renderables.find((r) => r.label === "text3") as RenderableText;
        expect(text2?.visible).toBe(true);
        expect(text3?.visible).toBe(true);
        // text2 anchored at F - (0.1, 0.2) → x = 1 - δ - 0.1 = 0.7
        expect(text2.x).toBeCloseTo(0.7, 6);
        expect(text2.y).toBeCloseTo(-0.2, 6);
        // text3 anchored at H - (0.1, 0.2); H = (1+δ, 0) → x = 1 + δ - 0.1 = 1.1
        expect(text3.x).toBeCloseTo(1.1, 6);
        expect(text3.y).toBeCloseTo(-0.2, 6);
    });
});
