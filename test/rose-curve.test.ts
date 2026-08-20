/**
 * rose-curve.ggb — CurveCartesian parametric curve rendering.
 *
 * The curve `r = CurveCartesian((a·sin(n·θ)); θ, θ, 0, 2π)` is a polar rose:
 * the point `(a·sin(n·θ); θ)` uses GeoGebra's `;` polar-coordinate syntax
 * (radius; angle), so the drawn point is `(a·sin(n·θ)·cos θ, a·sin(n·θ)·sin θ)`
 * — i.e. the rose r = a·sin(n·θ). n=1 → a circle, n=2 → 4 petals, n=3 → 3
 * petals, n=4 → 8 petals, and `a` sets the overall size.
 *
 * geoview previously had no support for `curvecartesian` elements — the curve
 * was silently dropped. These tests confirm the parametric renderable is built
 * and that the sampler produces the correct polar geometry over `[0, 2π]`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb, buildScene, sampleParametricCurve } from "../src/index";
import { Kernel } from "../src/kernel";
import type { RenderableParametricCurve } from "../src/render-types";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/rose-curve.ggb"));
const doc = parseGgb(data);
const kernel = new Kernel(doc);
const scene = buildScene(doc, { mode: "2d", width: 800, height: 600, kernel });

describe("rose-curve.ggb — CurveCartesian parametric curve", () => {
    it("builds a parametric renderable for the curve r", () => {
        const r = scene.renderables.find(
            (x) => x.label === "r"
        ) as RenderableParametricCurve | undefined;
        expect(r).toBeDefined();
        expect(r!.kind).toBe("parametric");
        // CurveCartesian inputs are carried as strings for live re-sampling.
        expect(r!.pointExpr).toContain(";");
        expect(r!.paramVar).toBe("θ");
        expect(r!.tRangeExpr).toEqual(["0", "(2 * pi)"]);
    });

    it("exposes the driving sliders n and a as numbers", () => {
        const n = kernel.getValue("n");
        const a = kernel.getValue("a");
        expect(n?.kind).toBe("number");
        expect(a?.kind).toBe("number");
        expect((n as { value: number }).value).toBeGreaterThanOrEqual(1);
        expect((a as { value: number }).value).toBeGreaterThanOrEqual(1);
    });

    it("samples the polar rose r=a·sin(nθ): n=1 is a circle through the origin", () => {
        const r = scene.renderables.find(
            (x) => x.label === "r"
        ) as RenderableParametricCurve | undefined;
        expect(r).toBeDefined();

        // n=1: r = a·sin(θ) over [0,2π] is the circle x²+(y-a/2)²=(a/2)²,
        // lying entirely in y≥0 (the lower half retraces the upper via r<0).
        const segs = sampleParametricCurve(
            r!.pointExpr,
            r!.paramVar,
            r!.tRangeExpr,
            {
                xRange: [-8, 8],
                yRange: [-8, 8],
                pixelWidth: 800,
                pixelHeight: 800,
                scope: { n: 1, a: 5 }
            }
        );
        expect(segs.length).toBeGreaterThan(0);
        const pts = segs.flatMap((s) => s.points);
        expect(pts.length).toBeGreaterThan(8);
        for (const p of pts) {
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
        }
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        // Circle radius a/2 = 2.5 centered at (0, 2.5): x∈[-2.5,2.5], y∈[0,5].
        expect(Math.max(...xs)).toBeGreaterThan(2);
        expect(Math.min(...xs)).toBeLessThan(-2);
        expect(Math.max(...ys)).toBeGreaterThan(4);
        // Never dips below the origin (r=a·sin(θ) keeps y≥0).
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-6);
    });

    it("reshapes with n: n=2 has petals below the origin (y<0), n=1 does not", () => {
        const r = scene.renderables.find(
            (x) => x.label === "r"
        ) as RenderableParametricCurve | undefined;
        expect(r).toBeDefined();

        const sample = (n: number) =>
            sampleParametricCurve(r!.pointExpr, r!.paramVar, r!.tRangeExpr, {
                xRange: [-8, 8],
                yRange: [-8, 8],
                pixelWidth: 800,
                pixelHeight: 800,
                scope: { n, a: 5 }
            }).flatMap((s) => s.points);

        const minY = (pts: Array<{ y: number }>) => Math.min(...pts.map((p) => p.y));

        const n1 = sample(1);
        const n2 = sample(2);
        expect(n1.length).toBeGreaterThan(0);
        expect(n2.length).toBeGreaterThan(0);
        // n=1 circle stays in y≥0; n=2 (4 petals across all quadrants) reaches y<0.
        expect(minY(n1)).toBeGreaterThanOrEqual(-1e-6);
        expect(minY(n2)).toBeLessThan(-1);
    });

    it("scales with a: larger a gives a larger curve (max radius grows)", () => {
        const r = scene.renderables.find(
            (x) => x.label === "r"
        ) as RenderableParametricCurve | undefined;
        expect(r).toBeDefined();

        const maxRadius = (a: number) => {
            const pts = sampleParametricCurve(
                r!.pointExpr, r!.paramVar, r!.tRangeExpr,
                {
                    xRange: [-12, 12], yRange: [-12, 12],
                    pixelWidth: 800, pixelHeight: 800,
                    scope: { n: 2, a }
                }
            ).flatMap((s) => s.points);
            return Math.max(...pts.map((p) => Math.hypot(p.x, p.y)));
        };
        // a controls overall size: the farthest point scales with a.
        expect(maxRadius(5)).toBeGreaterThan(maxRadius(2));
    });

    it("returns empty for a degenerate range (start === end)", () => {
        const r = scene.renderables.find(
            (x) => x.label === "r"
        ) as RenderableParametricCurve | undefined;
        expect(r).toBeDefined();
        const segs = sampleParametricCurve(
            r!.pointExpr,
            r!.paramVar,
            ["0", "0"],
            {
                xRange: [-8, 8],
                yRange: [-8, 8],
                pixelWidth: 800,
                pixelHeight: 800,
                scope: { n: 1, a: 5 }
            }
        );
        expect(segs).toHaveLength(0);
    });
});
