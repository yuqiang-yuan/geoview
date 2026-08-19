/**
 * differentiable-tangent.ggb — value-mode line label (the tangent's equation).
 *
 * The tangent line `g` has labelMode=2 (GeoGebra "Value") with eqnStyle
 * "explicit", so GeoGebra draws its equation `y = m·x + b` beside the line.
 * Previously drawLine emitted no label at all, so the formula was missing.
 * This locks the line-equation label in place, including the vertical-line
 * fallback (line h, x = 0) which uses the same value-mode rendering.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, buildScene } from "../src/index";

const data = readFileSync(
    resolve(import.meta.dirname, "fixtures/differentiable-tangent.ggb")
);
const scene = buildScene(parseGgb(data), { mode: "2d", width: 800, height: 600 });

describe("differentiable-tangent.ggb — value-mode line labels", () => {
    it("tangent g carries an explicit y = m·x + b equation label", () => {
        const g = scene.renderables.find((r) => r.label === "g");
        expect(g).toBeDefined();
        expect(g?.showLabel).toBe(true);
        // LaTeX-wrapped explicit equation, 2 dp (GeoGebra's default decimals).
        // g: a = -0.18595, b = 1, c = 0.89258 → y = 0.19·x - 0.89.
        expect((g as { labelText?: string }).labelText).toBe(
            "\\(y = 0.19\\,x - 0.89\\)"
        );
    });

    it("vertical line h carries an x = const equation label", () => {
        const h = scene.renderables.find((r) => r.label === "h");
        expect(h).toBeDefined();
        expect(h?.showLabel).toBe(true);
        // h is the vertical tangent at x = 0 (a = 1.8, b = 0, c = 0 → x = 0).
        expect((h as { labelText?: string }).labelText).toBe("\\(x = 0\\)");
    });
});
