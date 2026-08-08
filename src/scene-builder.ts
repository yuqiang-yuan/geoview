/**
 * geoview — Scene builder.
 *
 * Converts a parsed GgbDocument into a backend-agnostic Scene
 * containing renderable objects. This is the bridge between
 * parsing and rendering.
 */

import type { GgbDocument, GgbElement, GgbExpression, GgbKernel } from "./types";
import type {
    Renderable,
    RenderableBase,
    RenderableFunction,
    Scene,
    SceneAxis,
    SceneBuildOptions,
    Viewport2D
} from "./render-types";
import { ggbColorToCss } from "./render-types";
import { buildViewport, extractDataRange } from "./viewport";

/**
 * Build a Scene from a parsed GgbDocument.
 *
 * @param doc     parsed GgbDocument
 * @param options width/height/mode/samples configuration
 * @returns a Scene ready for rendering
 */
export function buildScene(
    doc: GgbDocument,
    options: SceneBuildOptions = {}
): Scene {
    const view = doc.euclidianView;
    const width = options.width ?? view?.size?.width ?? 800;
    const height = options.height ?? view?.size?.height ?? 600;

    const viewport = buildViewport(view, width, height) as Viewport2D;

    // Extract data range for function sampling
    const range = extractDataRange(view);
    const xRange: [number, number] = options.xRange ??
        (range ? [range.xMin, range.xMax] : [-10, 10]);
    const yRange: [number, number] = range
        ? [range.yMin, range.yMax]
        : [-10, 10];

    // Build axis definitions
    const axes: SceneAxis[] | undefined = view?.axes?.map((a) => ({
        id: a.id,
        show: a.show,
        label: a.label,
        unitLabel: a.unitLabel,
        showNumbers: a.showNumbers,
        tickStyle: a.tickStyle,
        tickDistance: a.tickDistance,
        tickExpression: a.tickExpression
    }));

    // Build renderables from construction items
    const renderables: Renderable[] = [];
    const elementMap = buildElementMap(doc);

    for (const item of doc.construction.items) {
        if (item.kind === "expression") {
            // Find the matching element (same label) for style info
            const element = elementMap.get(item.label);
            const r = buildFunctionRenderable(
                item,
                element,
                doc.kernel,
                xRange,
                yRange
            );
            if (r) renderables.push(r);
        }
        // Commands and other item types will be handled in later phases
    }

    return {
        mode: "2d",
        viewport,
        bgColor: ggbColorToCss(view?.bgColor),
        axisColor: ggbColorToCss(view?.axesColor),
        gridColor: ggbColorToCss(view?.gridColor),
        showAxes: view?.evSettings?.axes ?? true,
        showGrid: view?.evSettings?.grid ?? false,
        axesLineStyle: view?.axesLineStyle,
        axes,
        renderables,
        kernel: doc.kernel
    };
}

/**
 * Build a lookup map of element labels → element properties.
 */
function buildElementMap(
    doc: GgbDocument
): Map<string, GgbElement> {
    const map = new Map<string, GgbElement>();
    for (const item of doc.construction.items) {
        if (item.kind === "element") {
            map.set(item.label, item as GgbElement);
        }
    }
    return map;
}

/**
 * Convert an expression + element pair into a RenderableFunction.
 */
function buildFunctionRenderable(
    expr: GgbExpression,
    element: GgbElement | undefined,
    kernel: GgbKernel | undefined,
    xRange: [number, number],
    yRange: [number, number]
): RenderableFunction | undefined {
    if (expr.type && expr.type !== "function") return undefined;
    if (!expr.exp) return undefined;

    const base: RenderableBase = {
        label: expr.label,
        visible: element?.show?.object !== false,
        color: ggbColorToCss(element?.objColor),
        strokeWidth: element?.lineStyle?.thickness,
        lineStyle: element?.lineStyle?.type,
        opacity: element?.lineStyle?.opacity !== undefined
            ? element.lineStyle.opacity / 255
            : undefined,
        showLabel: element?.show?.label ?? false,
        zOrder: element?.ordering ?? 0
    };

    return {
        ...base,
        kind: "function",
        expression: expr.exp,
        angleUnit: kernel?.angleUnit === "degree" ? "degree" : "radian",
        xRange,
        yRange
    };
}
