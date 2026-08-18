/**
 * Kernel + parser tests against limit.ggb.
 *
 * limit.ggb drives a Sequence-generated point list l1 = Sequence((i, i/(i+3)), i, 1, n)
 * where the free slider n animates 1→40. Two buttons run ggbscripts ("开始" toggles
 * animation, "复位" sets n=1). Verifies the Sequence recipe, ListValue, and button
 * parsing (ggbscript / labelOffset / caption / animation settings).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseGgb } from "../src/index";
import { Kernel } from "../src/kernel";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/limit.ggb"));
const doc = parseGgb(data);

function button(label: string) {
    return doc.construction.items.find(
        (it) => it.kind === "element" && it.type === "button" && it.label === label
    );
}
function numeric(label: string) {
    return doc.construction.items.find(
        (it) => it.kind === "element" && it.type === "numeric" && it.label === label
    );
}

describe("parser - limit.ggb buttons", () => {
    it("parses ggbscript, caption, and labelOffset for button1", () => {
        const b = button("button1");
        expect(b).toBeDefined();
        if (b?.kind !== "element") return;
        expect(b.caption).toBe("开始");
        expect(b.ggbscript).toContain("StartAnimation");
        expect(b.ggbscript).toContain("SetCaption");
        expect(b.labelOffset).toEqual({ x: 295, y: 211 });
    });

    it("parses the reset button (n=1)", () => {
        const b = button("button2");
        expect(b).toBeDefined();
        if (b?.kind !== "element") return;
        expect(b.caption).toBe("复位");
        expect(b.ggbscript).toBe("n=1");
        expect(b.labelOffset).toEqual({ x: 181, y: 211 });
    });

    it("parses slider n animation settings", () => {
        const n = numeric("n");
        if (n?.kind !== "element") throw new Error("n not found");
        expect(n.animation?.type).toBe(3);
        expect(n.animation?.step).toBe(1);
        expect(n.animation?.speed).toBe(1);
        expect(n.slider?.min).toBe(1);
        expect(n.slider?.max).toBe(40);
    });
});

describe("kernel - limit.ggb Sequence", () => {
    const kernel = new Kernel(doc);

    it("resolves n as a free number = 1", () => {
        const n = kernel.getValue("n");
        expect(n?.kind).toBe("number");
        if (n?.kind === "number") expect(n.value).toBe(1);
    });

    it("resolves l1 as a 1-point list at n=1", () => {
        const l1 = kernel.getValue("l1");
        expect(l1?.kind).toBe("list");
        if (l1?.kind !== "list") return;
        expect(l1.points).toHaveLength(1);
        expect(l1.points[0].x).toBeCloseTo(1, 6);
        expect(l1.points[0].y).toBeCloseTo(1 / 4, 6);
    });

    it("grows l1 when n changes", () => {
        kernel.setValue("n", { kind: "number", value: 5 });
        const l1 = kernel.getValue("l1");
        expect(l1?.kind).toBe("list");
        if (l1?.kind !== "list") return;
        expect(l1.points).toHaveLength(5);
        // last point (5, 5/8)
        expect(l1.points[4].x).toBeCloseTo(5, 6);
        expect(l1.points[4].y).toBeCloseTo(5 / 8, 6);
    });
});
