/**
 * Integration tests with exp.ggb - a graphing-view file containing
 * interval-restricted functions (If[...]), points, segments, and
 * LaTeX text objects.
 *
 * (An earlier revision of this fixture stored y = x^2 as a conic;
 * conic parsing/sampling is covered by conic.test.ts with that
 * exact matrix.)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    parseGgb,
    buildScene,
    ggbToMathJs,
    compileExpression,
    sampleFunction
} from "../src/index";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/exp.ggb"));
const doc = parseGgb(data);
const scene = buildScene(doc, { width: 800, height: 600 });

describe("exp.ggb - If[] function support", () => {
    it("translates If with a chained comparison to a mathjs ternary", () => {
        expect(ggbToMathJs("If[0 ≤ x ≤ 1.1, x^(2)]")).toBe(
            "((0 <= x) and (x <= 1.1) ? x^(2) : NaN)"
        );
    });

    it("translates If with an explicit default", () => {
        expect(ggbToMathJs("If[x < 0, -x, x]")).toBe("(x < 0 ? -x : x)");
    });

    it("leaves plain expressions untouched (operators normalised)", () => {
        expect(ggbToMathJs("sin(x) + 1")).toBe("sin(x) + 1");
        expect(ggbToMathJs("a ∧ b ∨ c")).toBe("a  and  b  or  c");
    });

    it("normalizes GeoGebra's U+212F/U+2147 constant e to mathjs e", () => {
        // GeoGebra writes the mathematical constant e as "ℯ" (U+212F)
        // or occasionally "ⅇ" (U+2147); mathjs needs plain "e".
        expect(ggbToMathJs("ℯ^(x)")).toBe("e^(x)");
        expect(ggbToMathJs("ⅇ^x")).toBe("e^x");
    });

    it("compiles and evaluates (e^x - e^-x)/2 as sinh", () => {
        // exp-2.ggb stores sinh as h(x) = (ℯ^(x) - ℯ^((-x))) / 2
        const fn = compileExpression("h(x) = (ℯ^(x) - ℯ^((-x))) / 2");
        expect(fn(0)).toBeCloseTo(0, 10);
        expect(fn(1)).toBeCloseTo(Math.sinh(1), 10);
        expect(fn(-1)).toBeCloseTo(Math.sinh(-1), 10);
    });

    it("compiles f(x) = If[0 ≤ x ≤ 1.1, x^(2)] with correct domain", () => {
        const fn = compileExpression("f(x) = If[0 ≤ x ≤ 1.1, x^(2)]");
        expect(fn(0.5)).toBeCloseTo(0.25, 10);
        expect(fn(1)).toBeCloseTo(1, 10);
        expect(Number.isNaN(fn(-0.1))).toBe(true);  // outside the interval
        expect(Number.isNaN(fn(1.2))).toBe(true);
    });

    it("samples the fixture's f into one bounded segment", () => {
        const fExpr = doc.construction.items.find(
            (i) => i.kind === "expression" && i.label === "f"
        );
        expect(fExpr).toBeDefined();
        const exp = (fExpr as { exp: string }).exp;
        const res = sampleFunction(compileExpression(exp), {
            xRange: [-1, 2],
            yRange: [-1, 2],
            angleUnit: "radian",
            nSamples: 400,
            pixelWidth: 900,
            pixelHeight: 300
        });
        expect(res.segments.length).toBeGreaterThanOrEqual(1);
        const pts = res.segments.flatMap((s) => s.points);
        expect(pts.length).toBeGreaterThan(10);
        // All sampled points are inside [0, 1.1] and on y = x^2
        for (const p of pts) {
            expect(p.x).toBeGreaterThanOrEqual(-1e-9);
            expect(p.x).toBeLessThanOrEqual(1.1 + 1e-9);
            expect(p.y).toBeCloseTo(p.x * p.x, 6);
        }
    });
});

describe("exp.ggb - scene building", () => {
    it("builds function renderables for f, g, h, p", () => {
        const kinds = scene.renderables.map((r) => `${r.label}:${r.kind}`);
        for (const expected of ["f:function", "g:function", "h:function", "p:function"]) {
            expect(kinds).toContain(expected);
        }
    });

    it("builds points and segments", () => {
        const kinds = scene.renderables.map((r) => `${r.label}:${r.kind}`);
        for (const expected of [
            "A:point", "B:point", "C:point", "i:segment", "j:segment"
        ]) {
            expect(kinds).toContain(expected);
        }
    });
});

describe("exp.ggb - text support", () => {
    it("builds text renderables instead of bogus functions", () => {
        const labels = scene.renderables.map((r) => `${r.label}:${r.kind}`);
        expect(labels).toContain("text1:text");
        expect(labels).toContain("text5:text");
        // No text object should leak into the function pipeline anymore
        expect(labels).not.toContain("text1:function");
        expect(labels).not.toContain("text5:function");
    });

    it("strips quotes and keeps LaTeX flags", () => {
        const text1 = scene.renderables.find((r) => r.label === "text1");
        expect(text1?.kind).toBe("text");
        const t1 = text1 as Extract<typeof text1, { kind: "text" }>;
        expect(t1.content).toBe("y=x^2");
        expect(t1.isLatex).toBe(true);
        expect(t1.serif).toBe(true);

        const text4 = scene.renderables.find(
            (r) => r.label === "text4"
        ) as Extract<(typeof scene.renderables)[number], { kind: "text" }>;
        expect(text4.content).toBe("y=x^{-\\frac{1}{3}}");
        expect(text4.isLatex).toBe(true);
    });

    it("anchors text at its startPoint", () => {
        const text5 = scene.renderables.find(
            (r) => r.label === "text5"
        ) as Extract<(typeof scene.renderables)[number], { kind: "text" }>;
        expect(text5.x).toBeCloseTo(0.007821753906215423, 10);
        expect(text5.y).toBeCloseTo(-0.007821753906215423, 10);
    });

    it("derives font size from the GUI font and sizeM", () => {
        const text1 = scene.renderables.find(
            (r) => r.label === "text1"
        ) as Extract<(typeof scene.renderables)[number], { kind: "text" }>;
        // gui font size 16, sizeM 1, size 0 -> 16
        expect(text1.fontSize).toBe(16);
    });

    it("keeps the text color from the element", () => {
        const text1 = scene.renderables.find(
            (r) => r.label === "text1"
        ) as Extract<(typeof scene.renderables)[number], { kind: "text" }>;
        // <objColor r="56" g="140" b="131" alpha="0"/>
        expect(text1.color).toBe("rgba(56, 140, 131, 1)");
    });
});
