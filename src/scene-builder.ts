/**
 * geoview — Scene builder.
 *
 * Converts a parsed GgbDocument into a backend-agnostic Scene
 * containing renderable objects. This is the bridge between
 * parsing and rendering.
 */

import type { GgbDocument, GgbElement, GgbExpression, GgbKernel, GgbCoords } from "./types";
import type {
    Renderable,
    RenderableBase,
    RenderableFunction,
    RenderablePoint,
    RenderableSegment,
    RenderableLine,
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

    // --- Build lookup tables for resolving command references ---

    // label → element properties (visual style, coords, etc.)
    const elementMap = buildElementMap(doc);

    // label → resolved 2D coordinates (for point references)
    const coordMap = buildCoordMap(doc, elementMap);

    // label → command that produced it (to know Segment(A,B) inputs)
    const outputLabelToCommand = buildCommandMap(doc);

    // --- Build renderables from construction items ---

    const renderables: Renderable[] = [];

    for (const item of doc.construction.items) {
        if (item.kind === "expression") {
            // Expression with type="point" → point renderable
            if (item.type === "point") {
                const element = elementMap.get(item.label);
                const r = buildPointRenderable(item.label, element);
                if (r) renderables.push(r);
                continue;
            }
            // Expression with type="function" (or no type) → function renderable
            const element = elementMap.get(item.label);
            const r = buildFunctionRenderable(
                item,
                element,
                doc.kernel,
                xRange,
                yRange,
                options.showAsymptotes
            );
            if (r) renderables.push(r);
        } else if (item.kind === "element") {
            // Standalone element not covered by expression/command above
            // (e.g. points defined only via <element>)
            const existing = renderables.find(
                (r) => r.label === item.label
            );
            if (existing) continue; // already built from expression

            if (item.type === "point") {
                const r = buildPointRenderable(item.label, item);
                if (r) renderables.push(r);
            } else if (item.type === "segment") {
                const cmd = outputLabelToCommand.get(item.label);
                const r = buildSegmentRenderable(item, cmd, coordMap);
                if (r) renderables.push(r);
            } else if (item.type === "line") {
                const r = buildLineRenderable(item);
                if (r) renderables.push(r);
            } else if (item.type === "ray") {
                // Ray handled like segment for now (TODO: extend to canvas edge)
                const cmd = outputLabelToCommand.get(item.label);
                const r = buildSegmentRenderable(item, cmd, coordMap);
                if (r) renderables.push(r);
            }
        }
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

// ============================================================
// Lookup table builders
// ============================================================

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
 * Build a lookup map of point labels → normalized 2D coordinates.
 * GGB points use homogeneous coords (x, y, z) where z=1 for finite
 * points. We dehomogenize: actual_x = x/z, actual_y = y/z.
 */
function buildCoordMap(
    doc: GgbDocument,
    elementMap: Map<string, GgbElement>
): Map<string, { x: number; y: number }> {
    const map = new Map<string, { x: number; y: number }>();
    for (const item of doc.construction.items) {
        if (item.kind === "element" && item.type === "point") {
            const c = item.coords;
            if (c) {
                const z = c.z || 1;
                map.set(item.label, {
                    x: c.x / z,
                    y: c.y / z
                });
            }
        }
        if (item.kind === "expression" && item.type === "point") {
            const el = elementMap.get(item.label);
            const c = el?.coords;
            if (c) {
                const z = c.z || 1;
                map.set(item.label, {
                    x: c.x / z,
                    y: c.y / z
                });
            }
        }
    }
    return map;
}

/**
 * Build a lookup map of output labels → command (for Segment(A,B) etc.)
 */
function buildCommandMap(
    doc: GgbDocument
): Map<string, { name: string; input: string[] }> {
    const map = new Map<string, { name: string; input: string[] }>();
    for (const item of doc.construction.items) {
        if (item.kind === "command") {
            for (const outLabel of item.output) {
                map.set(outLabel, {
                    name: item.name,
                    input: item.input
                });
            }
        }
    }
    return map;
}

// ============================================================
// Renderable builders
// ============================================================

/**
 * Convert an expression + element pair into a RenderableFunction.
 */
function buildFunctionRenderable(
    expr: GgbExpression,
    element: GgbElement | undefined,
    kernel: GgbKernel | undefined,
    xRange: [number, number],
    yRange: [number, number],
    showAsymptotes?: boolean
): RenderableFunction | undefined {
    if (expr.type && expr.type !== "function") return undefined;
    if (!expr.exp) return undefined;

    const base = buildBase(expr.label, element);

    return {
        ...base,
        kind: "function",
        expression: expr.exp,
        angleUnit: kernel?.angleUnit === "degree" ? "degree" : "radian",
        xRange,
        yRange,
        showAsymptotes
    };
}

/**
 * Build a point renderable from an element.
 */
function buildPointRenderable(
    label: string,
    element: GgbElement | undefined
): RenderablePoint | undefined {
    if (!element?.coords) return undefined;
    const c = element.coords;
    const z = c.z || 1;

    const base = buildBase(label, element);

    return {
        ...base,
        kind: "point",
        x: c.x / z,
        y: c.y / z,
        pointSize: element.pointSize,
        pointStyle: element.pointStyle
    };
}

/**
 * Build a segment renderable from an element + its producing command.
 * The command's inputs reference the two endpoint labels.
 */
function buildSegmentRenderable(
    element: GgbElement,
    cmd: { name: string; input: string[] } | undefined,
    coordMap: Map<string, { x: number; y: number }>
): RenderableSegment | undefined {
    // Try to get endpoints from command inputs
    let p1: { x: number; y: number } | undefined;
    let p2: { x: number; y: number } | undefined;

    if (cmd && cmd.input.length >= 2) {
        p1 = coordMap.get(cmd.input[0]);
        p2 = coordMap.get(cmd.input[1]);
    }

    // Fallback: if no command inputs, try to derive from coords
    // (segment coords are homogeneous line equation, not endpoints)
    if (!p1 || !p2) {
        // Can't determine endpoints — skip for now
        // TODO: parse startPoint or other element data
        return undefined;
    }

    const base = buildBase(element.label, element);

    return {
        ...base,
        kind: "segment",
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y
    };
}

/**
 * Build a line renderable from an element.
 * Lines use homogeneous coords (a, b, c) for ax + by + c = 0.
 */
function buildLineRenderable(
    element: GgbElement
): RenderableLine | undefined {
    if (!element.coords) return undefined;
    const c = element.coords;

    const base = buildBase(element.label, element);

    return {
        ...base,
        kind: "line",
        a: c.x,
        b: c.y,
        c: c.z
    };
}

/**
 * Build common base style from an element.
 */
function buildBase(
    label: string,
    element: GgbElement | undefined
): RenderableBase {
    return {
        label,
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
}
