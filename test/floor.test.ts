import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseGgb, compileExpression, sampleFunction } from "../src/index";
import type { SamplerParams } from "../src/index";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/floor.ggb"));
const doc = parseGgb(data);

describe("floor.ggb - parsing", () => {
    it("parses the floor expression", () => {
        const item = doc.construction.items[0];
        expect(item.kind).toBe("expression");
        expect((item as { exp: string }).exp).toBe("f(x) = floor(x)");
        expect((item as { type?: string }).type).toBe("function");
    });
});

// Viewport: 600x800 px over [-2.5, 3.5] x [-4, 4]
// -> 100 px per unit in both axes (pixel-space thresholds are easy to reason about)
function params(overrides: Partial<SamplerParams> = {}): SamplerParams {
    return {
        xRange: [-2.5, 3.5],
        yRange: [-4, 4],
        angleUnit: "radian",
        nSamples: 800,
        pixelWidth: 600,
        pixelHeight: 800,
        ...overrides
    };
}

describe("sampler - pixel-space discontinuity detection", () => {
    it("floor(x) splits at each integer into constant-y segments", () => {
        // [-2.5, 3.5] crosses integers -2..3 -> 7 constant runs
        const res = sampleFunction(compileExpression("f(x) = floor(x)"), params());
        expect(res.segments).toHaveLength(7);
        // Every segment is horizontal AND spans exactly one integer
        // interval [k, k+1] (snapped to the jump, not to sample points)
        for (let k = 0; k < res.segments.length; k++) {
            const seg = res.segments[k];
            const ys = new Set(seg.points.map((p) => p.y));
            expect(ys.size).toBe(1);
            const xs = seg.points.map((p) => p.x);
            const startExpect = Math.max(-2.5, k - 3);
            const endExpect = Math.min(3.5, k - 2);
            expect(xs[0]).toBeCloseTo(startExpect, 2);
            expect(xs[xs.length - 1]).toBeCloseTo(endExpect, 2);
            expect(seg.points[0].y).toBe(k - 3);
        }
        // floor has poles nowhere: no asymptotes
        expect(res.asymptotes).toHaveLength(0);
    });

    it("tan(x) splits at its poles and reports asymptote positions", () => {
        // [-pi, pi] with y in [-5, 5]: poles at -pi/2 and pi/2 -> 3 segments
        const res = sampleFunction(
            compileExpression("h(x) = tan(x)"),
            params({ xRange: [-Math.PI, Math.PI], yRange: [-5, 5] })
        );
        expect(res.segments).toHaveLength(3);
        expect(res.asymptotes).toHaveLength(2);
        for (const a of res.asymptotes) {
            const dist = Math.min(
                Math.abs(a - Math.PI / 2),
                Math.abs(a + Math.PI / 2)
            );
            expect(dist).toBeLessThan(0.02);
        }
    });

    it("tan(x) zoomed out draws no fake vertical connectors", () => {
        // 600px over [-20, 20] -> 15 px/unit; poles every ~47 px, and
        // y range [-50, 50] (8 px/unit). The old fixed-density sampler
        // drew near-vertical chords across poles here.
        const res = sampleFunction(
            compileExpression("h(x) = tan(x)"),
            params({ xRange: [-20, 20], yRange: [-50, 50] })
        );
        // All poles of tan in [-20, 20]: pi/2 + k*pi, k in [-6, 5] -> 12
        expect(res.asymptotes.length).toBeGreaterThanOrEqual(10);
        expect(res.segments.length).toBeGreaterThanOrEqual(10);
        // Branches must be uniform: each interior segment spans close
        // to one period minus the margin margin zones (~3.1 here)
        for (const seg of res.segments.slice(1, -1)) {
            const w = seg.points[seg.points.length - 1].x - seg.points[0].x;
            expect(w).toBeGreaterThan(2.9);
            expect(w).toBeLessThan(3.3);
        }
        // A fake connector would cross a pole: consecutive points with
        // large opposite-sign y values within one segment
        for (const seg of res.segments) {
            for (let i = 1; i < seg.points.length; i++) {
                const y0 = seg.points[i - 1].y;
                const y1 = seg.points[i].y;
                if (Math.abs(y0) > 20 && Math.abs(y1) > 20) {
                    expect((y0 > 0) === (y1 > 0)).toBe(true);
                }
            }
        }
    });

    it("tan(x) branches are symmetric: every branch reaches the margin on both sides", () => {
        // Each tan branch ascends from the bottom margin crossing
        // (just right of a pole) to the top margin crossing (just left
        // of the next pole). If either side is cut short, zooming out
        // shows visibly asymmetric strokes (regression: extendFromBreak
        // used to drop the margin crossing point itself).
        const res = sampleFunction(
            compileExpression("h(x) = tan(x)"),
            params({ xRange: [-60, 60], yRange: [-36, 36] })
        );
        expect(res.asymptotes.length).toBeGreaterThanOrEqual(30);
        const view = 36;
        const threshold = 0.9 * view; // near the margin (75 = 36 + 36/2)
        const xMin = -60, xMax = 60;
        for (const seg of res.segments) {
            // Edge segments are cut by the view boundary, not a pole:
            // asymmetry there is correct.
            if (seg.points[0].x < xMin + 0.5 || seg.points[seg.points.length - 1].x > xMax - 0.5) {
                continue;
            }
            const maxY = Math.max(...seg.points.map((p) => p.y));
            const minY = Math.min(...seg.points.map((p) => p.y));
            if (maxY > threshold) {
                // this branch reaches the top; it must also reach the bottom
                expect(minY).toBeLessThan(-threshold);
            }
        }
    });

    it("steep continuous function stays a single segment", () => {
        // 50x: 5000 px/px screen slope - steep but linear (zero curvature)
        const res = sampleFunction(
            compileExpression("f(x) = 50x"),
            params({ yRange: [-4, 4] })
        );
        expect(res.segments).toHaveLength(1);
        expect(res.asymptotes).toHaveLength(0);
    });

    it("abs(x) kink stays a single segment", () => {
        const res = sampleFunction(compileExpression("f(x) = abs(x)"), params());
        expect(res.segments).toHaveLength(1);
    });

    it("1/x splits at the pole and reports the asymptote", () => {
        // x in [-2, 2], y in [-5, 5]: pole at 0 -> 2 segments
        const res = sampleFunction(
            compileExpression("f(x) = 1/x"),
            params({ xRange: [-2, 2], yRange: [-5, 5] })
        );
        expect(res.segments).toHaveLength(2);
        expect(res.asymptotes).toHaveLength(1);
        expect(Math.abs(res.asymptotes[0])).toBeLessThan(0.05);
        // left branch all negative, right branch all positive
        const leftY = res.segments[0].points.map((p) => p.y);
        const rightY = res.segments[1].points.map((p) => p.y);
        expect(Math.max(...leftY)).toBeLessThanOrEqual(0);
        expect(Math.min(...rightY)).toBeGreaterThanOrEqual(0);
    });

    it("NaN samples are always treated as breaks", () => {
        // sin(x)/x is NaN at x=0 (removable hole): break, but no
        // asymptote line should be reported
        const res = sampleFunction(
            compileExpression("f(x) = sin(x)/x"),
            params({ xRange: [-10, 10], yRange: [-2, 2] })
        );
        expect(res.segments).toHaveLength(2);
        expect(res.asymptotes).toHaveLength(0);
    });

    it("adaptive subdivision resolves sharp features", () => {
        // A narrow Gaussian (sigma = 0.05 -> ~6 px wide at 100 px/unit)
        // must still produce a visible peak near x=1
        const res = sampleFunction(
            compileExpression("f(x) = exp(-((x - 1)^2) / (2*0.05^2))"),
            params()
        );
        const peak = Math.max(
            ...res.segments.flatMap((s) => s.points.map((p) => p.y))
        );
        expect(peak).toBeGreaterThan(0.95);
    });
});
