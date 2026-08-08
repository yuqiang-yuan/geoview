import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseGgb } from "../src/index";
import type { GgbElement, GgbExpression } from "../src/types";

const data = readFileSync(resolve(import.meta.dirname, "fixtures/sin-cos-tan.ggb"));
const doc = parseGgb(data);

describe("sin-cos-tan.ggb — meta", () => {
    it("parses meta info", () => {
        expect(doc.meta.format).toBe("5.0");
        expect(doc.meta.version).toBe("5.4.927.1");
        expect(doc.meta.app).toBe("suite");
        expect(doc.meta.platform).toBe("w");
    });
});

describe("sin-cos-tan.ggb — euclidian view", () => {
    it("parses coordinate system with 2:1 scale ratio", () => {
        const cs = doc.euclidianView?.coordSystem;
        expect(cs).toBeDefined();
        expect(cs!.scale).toBeCloseTo(38.812, 2);
        expect(cs!.yscale).toBeCloseTo(77.624, 2);
        // yscale should be 2x scale (2:1 ratio)
        expect(cs!.yscale / cs!.scale).toBeCloseTo(2, 5);
    });

    it("parses view size", () => {
        expect(doc.euclidianView?.size).toEqual({ width: 2096, height: 1256 });
    });

    it("parses evSettings", () => {
        expect(doc.euclidianView?.evSettings).toEqual({
            axes: true,
            grid: true,
            gridIsBold: false,
            pointCapturing: 3,
            gridType: 3,
            rightAngleStyle: 1,
            checkboxSize: 26
        });
    });

    it("parses colors", () => {
        expect(doc.euclidianView?.bgColor).toEqual({ r: 255, g: 255, b: 255 });
        expect(doc.euclidianView?.axesColor).toEqual({ r: 28, g: 28, b: 31 });
        expect(doc.euclidianView?.gridColor).toEqual({ r: 180, g: 179, b: 186 });
    });

    it("parses axes", () => {
        const axes = doc.euclidianView?.axes;
        expect(axes).toHaveLength(2);
        expect(axes![0].id).toBe(0);
        expect(axes![0].show).toBe(true);
        expect(axes![1].id).toBe(1);
        expect(axes![1].show).toBe(true);
    });
});

describe("sin-cos-tan.ggb — kernel", () => {
    it("parses kernel settings", () => {
        expect(doc.kernel?.angleUnit).toBe("degree");
        expect(doc.kernel?.algebraStyle).toBe(3);
        expect(doc.kernel?.continuous).toBe(false);
        expect(doc.kernel?.decimals).toBe(13);
    });
});

describe("sin-cos-tan.ggb — construction", () => {
    it("has 6 construction items (3 expressions + 3 elements)", () => {
        expect(doc.construction.items).toHaveLength(6);
    });

    it("parses sin expression", () => {
        const item = doc.construction.items[0];
        expect(item.kind).toBe("expression");
        const expr = item as GgbExpression;
        expect(expr.label).toBe("f");
        expect(expr.exp).toBe("f(x) = sin(x)");
        expect(expr.type).toBe("function");
    });

    it("parses cos expression", () => {
        const item = doc.construction.items[2];
        expect(item.kind).toBe("expression");
        const expr = item as GgbExpression;
        expect(expr.label).toBe("g");
        expect(expr.exp).toBe("g(x) = cos(x)");
        expect(expr.type).toBe("function");
    });

    it("parses tan expression", () => {
        const item = doc.construction.items[4];
        expect(item.kind).toBe("expression");
        const expr = item as GgbExpression;
        expect(expr.label).toBe("h");
        expect(expr.exp).toBe("h(x) = tan(x)");
        expect(expr.type).toBe("function");
    });

    it("parses sin element with color and style", () => {
        const item = doc.construction.items[1];
        expect(item.kind).toBe("element");
        const el = item as GgbElement;
        expect(el.type).toBe("function");
        expect(el.label).toBe("f");
        expect(el.objColor).toEqual({ r: 0, g: 103, b: 88, alpha: 0 });
        expect(el.lineStyle?.thickness).toBe(5);
        expect(el.fixed).toBe(true);
        expect(el.show).toEqual({ object: true, label: false });
    });

    it("parses cos element with color and style", () => {
        const item = doc.construction.items[3];
        expect(item.kind).toBe("element");
        const el = item as GgbElement;
        expect(el.type).toBe("function");
        expect(el.label).toBe("g");
        expect(el.objColor).toEqual({ r: 21, g: 101, b: 192, alpha: 0 });
    });

    it("parses tan element with color and style", () => {
        const item = doc.construction.items[5];
        expect(item.kind).toBe("element");
        const el = item as GgbElement;
        expect(el.type).toBe("function");
        expect(el.label).toBe("h");
        expect(el.objColor).toEqual({ r: 211, g: 47, b: 47, alpha: 0 });
    });
});
