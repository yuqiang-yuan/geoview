/**
 * Kernel sanity check against geogebra-export.ggb.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb } from "../src/index";
import { Kernel } from "../src/kernel";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/geogebra-export.ggb"));
const doc = parseGgb(data);
const kernel = new Kernel(doc);
const v = kernel.evaluate();

describe("kernel - geogebra-export.ggb", () => {
    it("resolves the FitPoly output f as a function", () => {
        const f = v.get("f");
        expect(f?.kind).toBe("function");
        if (f?.kind === "function") {
            // Interpolates the 5 fit points (degree 4) exactly.
            expect(f.evaluate(1)).toBeCloseTo(2.77, 6);
            expect(f.evaluate(3.86)).toBeCloseTo(4.22, 5);
            expect(f.evaluate(15.88)).toBeCloseTo(6.26, 5);
        }
    });

    it("resolves the slider δ as a number = 0", () => {
        const d = v.get("δ");
        expect(d?.kind).toBe("number");
        if (d?.kind === "number") expect(d.value).toBe(0);
    });

    it("resolves derived points from f and δ", () => {
        const m = v.get("M");
        expect(m?.kind).toBe("point");
        if (m?.kind === "point") {
            expect(m.x).toBeCloseTo(1, 10);
            expect(m.y).toBeCloseTo(2.77, 6); // f(1)
        }
        // δ = 0 → N == M, G == M
        const n = v.get("N");
        if (n?.kind === "point") expect(n.x).toBeCloseTo(1, 10);
    });

    it("recomputes dependents when δ changes", () => {
        kernel.setValue("δ", { kind: "number", value: 0.2 });
        const n = kernel.getValue("N");
        const f = kernel.getValue("f")!;
        if (n?.kind === "point" && f?.kind === "function") {
            expect(n.x).toBeCloseTo(1.2, 10);
            expect(n.y).toBeCloseTo(f.evaluate(1.2), 6);
        }
        const cond = kernel.evalCondition("δ ≠ 0");
        expect(cond).toBe(true);
    });

    it("evaluates the δ=0 visibility condition as false", () => {
        kernel.setValue("δ", { kind: "number", value: 0 });
        expect(kernel.evalCondition("δ ≠ 0")).toBe(false);
    });

    it("recomputes f when a fit point is dragged", () => {
        kernel.setValue("A'", { kind: "point", x: 1, y: 10 });
        const f = kernel.getValue("f");
        if (f?.kind === "function") {
            // A' moved to (1, 10); interpolation now passes through 10 at x=1.
            expect(f.evaluate(1)).toBeCloseTo(10, 6);
        }
    });

    it("lists free (draggable) objects", () => {
        const free = kernel.freeObjects();
        const labels = free.map((f) => f.label);
        expect(labels).toContain("A'");
        expect(labels).toContain("δ");
        expect(labels).not.toContain("f"); // f is derived
        expect(labels).not.toContain("M");
    });

    it("evaluates point expressions for text anchors that track δ", () => {
        // text2 anchor: F - (0.1, 0.2); F = (1-δ, 0).
        kernel.setValue("δ", { kind: "number", value: 0.3 });
        const p = kernel.evalPoint("F - (0.1, 0.2)");
        expect(p?.x).toBeCloseTo(1 - 0.3 - 0.1, 6); // 0.6
        expect(p?.y).toBeCloseTo(-0.2, 6);
    });
});
