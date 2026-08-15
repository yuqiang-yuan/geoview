/**
 * Tests for text object positioning: absolute screen location vs anchored.
 * interaction-1-2.ggb contains both kinds:
 *  - text7 "absolute": <absoluteScreenLocation x="1166" y="526"/>
 *  - text8 "anchor":   <startPoint x=2.872 y=1.607 z=1/>
 * plus kernel-anchored texts (text2/text3 at F-/H- offsets) like the
 * geogebra-export fixture.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, buildScene } from "../src/index";
import { Kernel } from "../src/kernel";
import type { RenderableText } from "../src/render-types";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/interaction-1-2.ggb"));
const doc = parseGgb(data);
const kernel = new Kernel(doc);
const scene = buildScene(doc, { width: 800, height: 600, kernel });

function text(label: string): RenderableText | undefined {
    return scene.renderables.find((r) => r.label === label) as RenderableText | undefined;
}

describe("interaction-1-2.ggb - text positioning", () => {
    it("parses <absoluteScreenLocation> as an absolute (screen-pixel) text", () => {
        const t = text("text7");
        expect(t).toBeDefined();
        expect(t?.content).toBe("absolute");
        expect(t?.absolute).toBe(true);
        expect(t?.x).toBe(1166);
        expect(t?.y).toBe(526);
    });

    it("parses <startPoint> as a math-anchored (non-absolute) text", () => {
        const t = text("text8");
        expect(t).toBeDefined();
        expect(t?.content).toBe("anchor");
        expect(t?.absolute).toBeFalsy();
        // startPoint math coords (dehomogenized, z=1)
        expect(t?.x).toBeCloseTo(2.872017555230761, 6);
        expect(t?.y).toBeCloseTo(1.6074447663865061, 6);
    });

    it("resolves kernel-anchored texts that track δ", () => {
        // text2 "x_0-δ" anchored at F - (0.1, 0.2); F = (1-δ, 0).
        kernel.setValue("δ", { kind: "number", value: 0.2 });
        const scene2 = buildScene(doc, { width: 800, height: 600, kernel });
        const t2 = scene2.renderables.find((r) => r.label === "text2") as RenderableText | undefined;
        const t3 = scene2.renderables.find((r) => r.label === "text3") as RenderableText | undefined;
        expect(t2?.absolute).toBeFalsy();
        expect(t3?.absolute).toBeFalsy();
        // text2: x = 1 - δ - 0.1 = 0.7
        expect(t2?.x).toBeCloseTo(0.7, 6);
        // text3: H - (0.1, 0.2); H = (1+δ, 0) → x = 1 + δ - 0.1 = 1.1
        expect(t3?.x).toBeCloseTo(1.1, 6);
    });
});
