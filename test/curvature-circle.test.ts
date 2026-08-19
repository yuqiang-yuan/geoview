/**
 * curvature-circle.ggb — text expression interpolation.
 *
 * The two text labels reference live values via `LaTeX[label]`:
 *  - text1 "圆心：A=(…)=…" ends with `LaTeX[A]` → the point A's coords.
 *  - text2 "半径：r=(…)" ends with `LaTeX[r]` → the curvature radius r.
 *
 * Previously the builder emitted the raw `(LaTeX[r])` literal because there
 * was no text-expression evaluator. With the kernel-driven evaluator the
 * references resolve against the live construction: the slider `a` feeds both
 * the radius `r` and the parabola `f` (an explicit conic treated as a
 * function), and `A = (a, f(a))` resolves to (80, 31.25).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, buildScene } from "../src/index";
import { Kernel } from "../src/kernel";

const data = readFileSync(
    resolve(import.meta.dirname, "fixtures/curvature-circle.ggb")
);
const doc = parseGgb(data);
const kernel = new Kernel(doc);
const scene = buildScene(doc, {
    mode: "2d",
    width: 1050,
    height: 503,
    kernel,
});

describe("curvature-circle.ggb — text expression interpolation", () => {
    it("radius r resolves to a finite number (slider-driven derived scalar)", () => {
        const r = kernel.getValue("r");
        expect(r?.kind).toBe("number");
        expect((r as { value: number }).value).toBeCloseTo(87.616, 1);
    });

    it("point A resolves to (80, 31.25) via the explicit-conic parabola f(a)", () => {
        const a = kernel.getValue("A");
        expect(a?.kind).toBe("point");
        const p = a as { x: number; y: number };
        expect(p.x).toBeCloseTo(80, 6);
        expect(p.y).toBeCloseTo(31.25, 2);
    });

    it("text2 (radius) interpolates LaTeX[r] instead of emitting the literal", () => {
        const text2 = scene.renderables.find(
            (r) => r.kind === "text" && r.label === "text2"
        ) as { content: string; isLatex: boolean } | undefined;
        expect(text2).toBeDefined();
        // The radius value is spliced in where (LaTeX[r]) was.
        expect(text2!.content.endsWith("87.62")).toBe(true);
        // And the raw interpolation token must not survive.
        expect(text2!.content).not.toContain("LaTeX[r]");
    });

    it("text1 (centre) interpolates LaTeX[A] with the resolved point coords", () => {
        const text1 = scene.renderables.find(
            (r) => r.kind === "text" && r.label === "text1"
        ) as { content: string } | undefined;
        expect(text1).toBeDefined();
        expect(text1!.content.endsWith("(80, 31.25)")).toBe(true);
        expect(text1!.content).not.toContain("LaTeX[A]");
    });

    it("radius r tracks the slider a, and the text value updates live", () => {
        // r = (1 + (0.8·a)²)^1.5 / 0.8
        kernel.setValue("a", { kind: "number", value: 0 });
        expect((kernel.getValue("r") as { value: number }).value).toBeCloseTo(1.25, 6);
        let s = buildScene(doc, { mode: "2d", width: 1050, height: 503, kernel });
        let t2 = s.renderables.find((r) => r.kind === "text" && r.label === "text2") as
            | { content: string }
            | undefined;
        expect(t2!.content.endsWith("1.25")).toBe(true);

        kernel.setValue("a", { kind: "number", value: 3 });
        expect((kernel.getValue("r") as { value: number }).value).toBeCloseTo(21.97, 2);
        s = buildScene(doc, { mode: "2d", width: 1050, height: 503, kernel });
        t2 = s.renderables.find((r) => r.kind === "text" && r.label === "text2") as
            | { content: string }
            | undefined;
        expect(t2!.content.endsWith("21.97")).toBe(true);
    });
});
