/**
 * Viewport fitting tests, focused on origin placement.
 *
 * The vertical-centring formula must use the opposite sign of the
 * horizontal one because Y maps as pixelY = yZero - y*scaleY (canvas y
 * is downward). A symmetric range masks this (yMin+yMax == 0); an
 * asymmetric range (origin off-centre) exposes it.
 */
import { describe, it, expect } from "vitest";
import { fitViewport } from "../src/viewport";

describe("fitViewport - origin placement", () => {
    it("places origin at the bottom for an all-positive y range", () => {
        // y in [0, 10], x in [-5, 5], square axes, canvas 100x100
        const vp = fitViewport({ xMin: -5, xMax: 5, yMin: 0, yMax: 10 }, 100, 100);
        // y=0 is the bottom of an all-positive range -> near pixel 100
        expect(vp.yZero).toBeCloseTo(100, 5);
        // y=10 (top) -> near pixel 0
        expect(vp.yZero - 10 * vp.scaleY).toBeCloseTo(0, 5);
    });

    it("places origin at the top for an all-negative y range", () => {
        const vp = fitViewport({ xMin: -5, xMax: 5, yMin: -10, yMax: 0 }, 100, 100);
        // y=0 is the top -> near pixel 0
        expect(vp.yZero).toBeCloseTo(0, 5);
    });

    it("centres a symmetric range (yMin == -yMax) at canvas middle", () => {
        const vp = fitViewport({ xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, 100, 100);
        expect(vp.yZero).toBeCloseTo(50, 5);
        expect(vp.xZero).toBeCloseTo(50, 5);
    });

    it("keeps origin lower-left for an asymmetric range like exp.ggb", () => {
        // exp.ggb: x in [-0.718, 4.747], y in [-0.859, 2.416]
        const vp = fitViewport(
            { xMin: -0.718, xMax: 4.747, yMin: -0.859, yMax: 2.416 },
            800, 600,
            { scale: 383.55, yscale: 383.55 } as any
        );
        // Origin x near the left, y below the vertical middle (lower-left)
        expect(vp.xZero / 800).toBeLessThan(0.2);
        expect(vp.yZero / 600).toBeGreaterThan(0.6);
    });
});
