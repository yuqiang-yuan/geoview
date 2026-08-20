/**
 * geoview — Scene builder.
 *
 * Converts a parsed GgbDocument into a backend-agnostic Scene
 * containing renderable objects. This is the bridge between
 * parsing and rendering.
 */

import type { GgbDocument, GgbElement, GgbExpression, GgbKernel, GgbCoords } from "./types";
import type {
    KernelLike,
    Renderable,
    RenderableBase,
    RenderableConic,
    RenderableFunction,
    RenderablePoint,
    RenderablePointList,
    RenderableSegment,
    RenderableLine,
    RenderableSlider,
    RenderableText,
    ResolvedValue,
    Scene,
    SceneAxis,
    SceneBuildOptions,
    Viewport2D
} from "./render-types";
import { ggbColorToCss } from "./render-types";
import { buildViewport, extractDataRange } from "./viewport";
import { matrixToCoefficients } from "./conic";

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

    // label → resolved 2D coordinates (for point references). When a kernel
    // is present, prefer its live point coords over the stored XML coords
    // (stored coords go stale the moment a free object is dragged).
    const coordMap = buildCoordMap(doc, elementMap, options.kernel);

    // label → command that produced it (to know Segment(A,B) inputs)
    const outputLabelToCommand = buildCommandMap(doc);

    const kernel = options.kernel;

    // --- Build renderables from construction items ---

    const renderables: Renderable[] = [];

    for (const item of doc.construction.items) {
        if (item.kind === "expression") {
            // Expression with type="point" → point renderable
            if (item.type === "point") {
                const element = elementMap.get(item.label);
                const r = buildPointRenderable(item.label, element, kernel);
                if (r) renderables.push(r);
                continue;
            }
            // Expression with type="text" → text renderable
            // (content is a quoted string in exp)
            if (item.type === "text" || elementMap.get(item.label)?.type === "text") {
                const element = elementMap.get(item.label);
                const r = buildTextRenderable(
                    item.label, element, item.exp, doc.gui?.font?.size, kernel, undefined
                );
                if (r) renderables.push(r);
                continue;
            }
            // String literal (exp starts with a quote) that is not a text
            // object - skip instead of feeding it to the sampler
            if (item.exp.startsWith("\"")) continue;
            // Expression with type="function" (or no type) → function renderable
            const element = elementMap.get(item.label);
            const r = buildFunctionRenderable(
                item,
                element,
                doc.kernel,
                xRange,
                yRange,
                options.showAsymptotes,
                kernel
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
                const r = buildPointRenderable(item.label, item, kernel);
                if (r) renderables.push(r);
            } else if (item.type === "segment") {
                const cmd = outputLabelToCommand.get(item.label);
                const r = buildSegmentRenderable(item, cmd, coordMap, kernel);
                if (r) renderables.push(r);
            } else if (item.type === "line") {
                const r = buildLineRenderable(item, kernel);
                if (r) renderables.push(r);
            } else if (item.type === "conic") {
                // GeoGebra stores circles/ellipses/parabolas/hyperbolas
                // uniformly as type="conic" with a packed matrix
                const r = buildConicRenderable(item);
                if (r) renderables.push(r);
            } else if (item.type === "ray") {
                // Ray handled like segment for now (TODO: extend to canvas edge)
                const cmd = outputLabelToCommand.get(item.label);
                const r = buildSegmentRenderable(item, cmd, coordMap, kernel);
                if (r) renderables.push(r);
            } else if (item.type === "function") {
                // Function produced by a command (e.g. FitPoly) with no
                // <expression> of its own — resolve its expression from the
                // kernel's computed function value.
                const r = buildFunctionRenderable(
                    undefined,
                    item,
                    doc.kernel,
                    xRange,
                    yRange,
                    options.showAsymptotes,
                    kernel
                );
                if (r) renderables.push(r);
            } else if (item.type === "numeric") {
                const r = buildSliderRenderable(item, kernel, doc.gui?.font?.size);
                if (r) renderables.push(r);
            } else if (item.type === "text") {
                // Text produced by a Text command (no <expression>): content
                // comes from the command's first input, anchor from its second
                // input (a point expression like "F - (0.1, 0.2)").
                const cmd = outputLabelToCommand.get(item.label);
                const content = cmd?.name === "Text" ? cmd.input[0] : undefined;
                const anchorExp = cmd?.name === "Text" ? cmd.input[1] : undefined;
                if (content !== undefined) {
                    const r = buildTextRenderable(
                        item.label, item, content, doc.gui?.font?.size, kernel, anchorExp
                    );
                    if (r) renderables.push(r);
                }
            } else if (item.type === "list") {
                const r = buildPointListRenderable(item, kernel);
                if (r) renderables.push(r);
            } else if (item.type === "button" || item.type === "boolean") {
                // Handled by the interactive button-overlay layer; not a renderable.
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
 * points. We dehomogenize: actual_x = x/z, actual_y = y/z. When a kernel
 * is present, its live point coords take precedence over stored coords.
 */
function buildCoordMap(
    doc: GgbDocument,
    elementMap: Map<string, GgbElement>,
    kernel?: KernelLike
): Map<string, { x: number; y: number }> {
    const map = new Map<string, { x: number; y: number }>();
    for (const item of doc.construction.items) {
        const label = item.kind === "element" ? item.label : item.kind === "expression" ? item.label : null;
        if (!label) continue;
        const kv = kernel?.getValue(label);
        if (kv?.kind === "point") {
            map.set(label, { x: kv.x, y: kv.y });
            continue;
        }
        const c = item.kind === "element"
            ? item.coords
            : item.kind === "expression" && item.type === "point"
                ? elementMap.get(item.label)?.coords
                : undefined;
        if (c) {
            const z = c.z || 1;
            map.set(label, { x: c.x / z, y: c.y / z });
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
    expr: GgbExpression | undefined,
    element: GgbElement | undefined,
    ggbKernel: GgbKernel | undefined,
    xRange: [number, number],
    yRange: [number, number],
    showAsymptotes?: boolean,
    kernel?: KernelLike
): RenderableFunction | undefined {
    const label = expr?.label ?? element?.label ?? "";
    if (expr && expr.type && expr.type !== "function") return undefined;

    // Resolve the expression string: from the <expression>, or — for
    // command-produced functions (e.g. FitPoly output with no <expression>) —
    // from the kernel's computed function value.
    let expression: string | undefined;
    if (expr?.exp && expr.exp.trim()) {
        expression = expr.exp;
    } else {
        const fv = kernel?.getValue(label);
        if (fv?.kind === "function") expression = fv.expression;
    }
    if (!expression) return undefined;

    const base = buildBase(label, element, kernel);

    return {
        ...base,
        kind: "function",
        expression,
        angleUnit: ggbKernel?.angleUnit === "degree" ? "degree" : "radian",
        xRange,
        yRange,
        showAsymptotes,
        scope: numericScope(kernel)
    };
}

/**
 * Collect the current free-number values as a sampler scope, so a function
 * expression may reference driving sliders/parameters (e.g. `α` in
 * `If[-2 <= t <= α, ...]`). Refreshed each buildScene; undefined when there
 * are no free numbers (preserves prior behaviour for scope-less fixtures).
 */
function numericScope(kernel?: KernelLike): Record<string, number> | undefined {
    if (!kernel) return undefined;
    const scope: Record<string, number> = {};
    let any = false;
    for (const obj of kernel.freeObjects()) {
        if (obj.kind !== "number") continue;
        const v = kernel.getValue(obj.label);
        if (v?.kind === "number") {
            scope[obj.label] = v.value;
            any = true;
        }
    }
    return any ? scope : undefined;
}

/**
 * Build a point renderable from an element. When a kernel is present,
 * its live point coords take precedence over the stored element coords.
 */
function buildPointRenderable(
    label: string,
    element: GgbElement | undefined,
    kernel?: KernelLike
): RenderablePoint | undefined {
    const kv = kernel?.getValue(label);
    let x: number | undefined;
    let y: number | undefined;
    if (kv?.kind === "point") {
        x = kv.x;
        y = kv.y;
    } else if (element?.coords) {
        const z = element.coords.z || 1;
        x = element.coords.x / z;
        y = element.coords.y / z;
    }
    if (x === undefined || y === undefined) return undefined;

    const base = buildBase(label, element, kernel);

    return {
        ...base,
        kind: "point",
        x,
        y,
        pointSize: element?.pointSize,
        pointStyle: element?.pointStyle
    };
}

/**
 * Build a point-list renderable from a `<element type="list">`. When a kernel
 * is present, its live list value (e.g. a Sequence output) drives the points;
 * otherwise the list is empty (lists have no stored point coords).
 */
function buildPointListRenderable(
    element: GgbElement,
    kernel?: KernelLike
): RenderablePointList | undefined {
    const kv = kernel?.getValue(element.label);
    const points = kv?.kind === "list" ? kv.points : [];
    const base = buildBase(element.label, element, kernel);
    return {
        ...base,
        kind: "pointlist",
        points,
        pointSize: element.pointSize,
        pointStyle: element.pointStyle
    };
}

/**
 * Build a segment renderable from an element + its producing command.
 * The command's inputs reference the two endpoint labels (resolved via
 * coordMap, which already reflects kernel coords when present).
 */
function buildSegmentRenderable(
    element: GgbElement,
    cmd: { name: string; input: string[] } | undefined,
    coordMap: Map<string, { x: number; y: number }>,
    kernel?: KernelLike
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

    const base = buildBase(element.label, element, kernel);

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
/**
 * Format a line's equation `a·x + b·y + c = 0` as a display label, matching
 * GeoGebra's value-mode (labelMode 2) rendering. Returns a LaTeX string
 * (`\( y = ... \)` / `\( x = ... \)`) so a MathJax-aware label renderer draws
 * it as a formula; the plain-text fallback strips the delimiters.
 *
 * In value mode the graphics view always shows the explicit form (`y = m·x + b`
 * for a non-vertical line, `x = const` for a vertical one) regardless of
 * eqnStyle — eqnStyle only affects the algebra view's representation, so we
 * ignore it here.
 */
function lineEquationLabel(
    a: number,
    b: number,
    c: number
): string | undefined {
    // Vertical line: b == 0 → x = -c/a.
    if (Math.abs(b) < 1e-12) {
        const x = Math.abs(a) < 1e-12 ? 0 : -c / a;
        return `\\(x = ${fmtNum(x)}\\)`;
    }
    // y = -(a·x + c) / b = m·x + k
    const m = -a / b;
    const k = -c / b;
    // Build "y = m x + k" with a proper sign so we never print "y = m x + -3".
    const mPart = fmtNum(m);
    const sign = k < 0 ? " - " : " + ";
    const kPart = fmtNum(Math.abs(k));
    return `\\(y = ${mPart}\\,x${sign}${kPart}\\)`;
}

/** Format a coefficient for display: 2 dp, matching GeoGebra's default
 *  `decimals` setting (e.g. 0.186 → "0.19", 0.8926 → "0.89"). Zero is shown
 *  without decimals for a clean `x = 0` / `... + 0`. */
function fmtNum(n: number): string {
    if (n === 0) return "0";
    return n.toFixed(2);
}

function buildLineRenderable(
    element: GgbElement,
    kernel?: KernelLike
): RenderableLine | undefined {
    if (!element.coords) return undefined;
    const c = element.coords;

    const base = buildBase(element.label, element, kernel);

    return {
        ...base,
        kind: "line",
        a: c.x,
        b: c.y,
        c: c.z,
        // GeoGebra labelMode 2 = "Value": show the line's equation rather than
        // its name. In value mode the graphics view always shows the explicit
        // form (`y = m·x + b`, or `x = const` for a vertical line) regardless
        // of eqnStyle (which only affects the algebra view). Wrapped as LaTeX
        // so a MathJax-aware label renderer formats it as a formula; the
        // plain-text fallback strips the delimiters.
        labelText:
            (base.showLabel && element.labelMode === 2)
                ? lineEquationLabel(c.x, c.y, c.z)
                : undefined
    };
}

/**
 * Build a conic renderable from an element's packed matrix.
 */
function buildConicRenderable(
    element: GgbElement
): RenderableConic | undefined {
    if (!element.matrix) return undefined;
    const co = matrixToCoefficients(element.matrix);

    const base = buildBase(element.label, element, undefined);

    return {
        ...base,
        kind: "conic",
        a: co.a,
        b: co.b,
        c: co.c,
        d: co.d,
        e: co.e,
        f: co.f
    };
}

/**
 * Strip the surrounding quotes from a GeoGebra text expression
 * (e.g. "\"y=x^2\"" -> "y=x^2").
 */
function unquoteText(exp: string): string {
    let s = exp.trim();
    if (s.length >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
        s = s.slice(1, -1);
    }
    return s;
}

/**
 * Split a GeoGebra text expression on top-level `+` operators, respecting
 * string literals and parenthesised sub-expressions (so a `+` inside a
 * quoted string or inside `(...)` is not treated as a concatenation split).
 */
function splitTextConcat(exp: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let start = 0;
    for (let i = 0; i < exp.length; i++) {
        const ch = exp[i];
        if (inString) {
            if (ch === "\\" && i + 1 < exp.length) { i++; continue; }
            if (ch === "\"") inString = false;
            continue;
        }
        if (ch === "\"") inString = true;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "+" && depth === 0) {
            parts.push(exp.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(exp.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Format a number for text display at GeoGebra's default 2 dp. */
function formatTextNumber(n: number): string {
    if (!Number.isFinite(n)) return "?";
    if (Number.isInteger(n)) return String(n);
    return parseFloat(n.toFixed(2)).toString();
}

/**
 * Evaluate a GeoGebra text expression to a display string. GeoGebra text is
 * string concatenation with `+`: quoted literals, `LaTeX[label]`/`(LaTeX[label])`
 * (a label's LaTeX representation), `(expr)` (a parenthesised numeric
 * expression), or a bare label reference. Each non-literal part is resolved
 * against the kernel's current values; unresolvable parts are left as-is so
 * the formula text still shows rather than vanishing.
 *
 * Quoted literals keep their inner LaTeX verbatim (e.g. `\[r = \frac{...}\]`),
 * so an `isLaTeX` text renders as a proper formula with live values spliced
 * in where `LaTeX[label]` appears.
 */
function evalTextExpression(exp: string, kernel?: KernelLike): string {
    if (!kernel) return unquoteText(exp);
    return splitTextConcat(exp)
        .map((part) => evalTextPart(part, kernel))
        .join("");
}

/** Evaluate a single concatenation part to a string. */
function evalTextPart(part: string, kernel: KernelLike): string {
    const p = part.trim();
    // Quoted string literal → inner content verbatim.
    if (p.startsWith("\"") && p.endsWith("\"")) {
        return p.slice(1, -1);
    }
    // (LaTeX[label]) or LaTeX[label] → the label's formatted value.
    const latex = p.replace(/^\(/, "").replace(/\)$/, "").trim();
    const m = /^LaTeX\[(.+)\]$/i.exec(latex);
    if (m) {
        return resolveLabelText(m[1].trim(), kernel);
    }
    // (expr) or bare expr → evaluate as a number if possible.
    const inner = p.replace(/^\(/, "").replace(/\)$/, "").trim();
    const num = tryEvalNumber(inner, kernel);
    return num !== undefined ? formatTextNumber(num) : p;
}

/** Format a label's value for display inside a LaTeX/text expression. */
function resolveLabelText(label: string, kernel: KernelLike): string {
    const v = kernel.getValue(label);
    if (!v) return label;
    if (v.kind === "number") return formatTextNumber(v.value);
    if (v.kind === "point") return `(${formatTextNumber(v.x)}, ${formatTextNumber(v.y)})`;
    if (v.kind === "function") return label;
    return label;
}

/** Best-effort numeric evaluation of an expression against the kernel scope. */
function tryEvalNumber(exp: string, kernel: KernelLike): number | undefined {
    const v = kernel.getValue(exp);
    if (v?.kind === "number") return v.value;
    return undefined;
}



/**
 * Build a text renderable. Content is a (possibly quoted) GeoGebra text
 * string from an `<expression>` or a Text command's first input. Positioning:
 *  - `<absoluteScreenLocation x= y=/>` → screen pixel coords that do NOT
 *    pan/zoom with the view (flagged `absolute: true`).
 *  - Text command's second input (a point expression like `"F - (0.1, 0.2)"`)
 *    → evaluated live via the kernel so the label tracks dragging.
 *  - `<startPoint x= y= z=/>` → stored math coords (a save-time snapshot
 *    that goes stale when free objects move), used when no kernel anchor.
 * Font size falls back to the GUI font size scaled by sizeM.
 */
function buildTextRenderable(
    label: string,
    element: GgbElement | undefined,
    contentExp: string | undefined,
    guiFontSize: number | undefined,
    kernel?: KernelLike,
    anchorExp?: string
): RenderableText | undefined {
    if (contentExp === undefined) return undefined;
    // Evaluate the text expression so label references (LaTeX[r], (LaTeX[A]))
    // and concatenations resolve to live values; falls back to the raw
    // unquoted string when there is nothing to interpolate.
    const content = evalTextExpression(contentExp, kernel);
    if (!content) return undefined;

    const base = buildBase(label, element, kernel);

    const size = element?.font?.size ?? 0;
    const sizeM = element?.font?.sizeM ?? 1;

    // Absolute screen positioning takes precedence over everything else.
    const abs = element?.absoluteScreenLocation;
    if (abs) {
        return {
            ...base,
            kind: "text",
            content,
            x: abs.x,
            y: abs.y,
            absolute: true,
            fontSize: size > 0 ? size : Math.round((guiFontSize ?? 16) * sizeM),
            isLatex: element?.isLaTeX,
            serif: element?.font?.isSerif
        };
    }

    const sp = element?.startPoint;
    const z = sp?.z || 1;

    // Prefer a kernel-resolved anchor (live) over the stored startPoint
    // (a save-time snapshot that goes stale when free objects move).
    const kpt = kernel?.evalPoint(anchorExp);
    const x = kpt ? kpt.x : (sp ? sp.x / z : 0);
    const y = kpt ? kpt.y : (sp ? sp.y / z : 0);

    return {
        ...base,
        kind: "text",
        content,
        x,
        y,
        fontSize: size > 0 ? size : Math.round((guiFontSize ?? 16) * sizeM),
        isLatex: element?.isLaTeX,
        serif: element?.font?.isSerif
    };
}

/**
 * Build a slider renderable from a `<element type="numeric">` with a
 * `<slider>` child. The current value comes from the kernel (or the
 * element's stored `<value>` as a fallback).
 */
function buildSliderRenderable(
    element: GgbElement,
    kernel: KernelLike | undefined,
    guiFontSize: number | undefined
): RenderableSlider | undefined {
    const sl = element.slider;
    if (!sl) return undefined;

    const kv = kernel?.getValue(element.label);
    const value = kv?.kind === "number" ? kv.value : element.value ?? sl.min;
    const anchorX = sl.x ?? 0;
    const anchorY = sl.y ?? 0;

    const base = buildBase(element.label, element, kernel);

    return {
        ...base,
        kind: "slider",
        x: anchorX,
        y: anchorY,
        min: sl.min,
        max: sl.max,
        step: sl.step,
        value,
        width: sl.width ?? 4,
        horizontal: sl.horizontal ?? true,
        absolute: sl.absolute,
        fontSize: guiFontSize
    };
}

/**
 * Build common base style from an element. When a kernel is present, a
 * `<condition showObject="..."/>` is evaluated against the current values
 * and ANDed with the `show.object` flag for the effective visibility.
 */
function buildBase(
    label: string,
    element: GgbElement | undefined,
    kernel?: KernelLike
): RenderableBase {
    const showObject = element?.show?.object !== false;
    const condVisible = kernel ? kernel.evalCondition(element?.condition) : true;
    return {
        label,
        visible: showObject && condVisible,
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
