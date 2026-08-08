/**
 * geoview — XML parser.
 *
 * Parses the geogebra.xml content into a typed GgbDocument.
 * Uses the browser-native DOMParser.
 *
 * Phase 1 scope: parse document structure, construction items (expression,
 * command, element, group), view settings, and element properties.
 * Does NOT evaluate expressions or execute commands.
 */

import type {
    GgbAlgebraView,
    GgbAnimation,
    GgbApp,
    GgbAxis,
    GgbColor,
    GgbCommand,
    GgbConstruction,
    GgbConstructionItem,
    GgbCoords,
    GgbDocument,
    GgbElement,
    GgbElementType,
    GgbEuclidianView,
    GgbEvSettings,
    GgbExpression,
    GgbFont,
    GgbGroup,
    GgbGui,
    GgbKernel,
    GgbLineStyle,
    GgbMeta,
    GgbScripting,
    GgbSlider
} from "./types";
import { GgbParseError } from "./types";

// ============================================================
// Minimal DOM types — narrow interfaces for XML parsing
// ============================================================

interface XmlElement {
    tagName: string;
    getAttribute(name: string): string | null;
    readonly children: { length: number; [i: number]: XmlElement };
}

interface XmlDocument {
    documentElement: XmlElement | null;
    querySelector?: (sel: string) => XmlElement | null;
}

function parseXmlDocument(xml: string): XmlDocument {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");

    // Check for parse errors (browser DOMParser inserts <parsererror>)
    const parseError = doc.querySelector?.("parsererror");
    if (parseError) {
        const text = (parseError as unknown as { textContent?: string }).textContent;
        throw new GgbParseError("XML parse error: " + text);
    }

    return doc;
}

// ============================================================
// Public API
// ============================================================

/**
 * Parse a geogebra.xml string into a typed GgbDocument.
 *
 * @param xml — the XML string from inside the .ggb archive
 * @returns typed document representation
 * @throws {GgbParseError} if the XML is invalid or missing required elements
 */
export function parseXml(xml: string): GgbDocument {
    const doc = parseXmlDocument(xml);
    const root = doc.documentElement;

    if (!root || root.tagName !== "geogebra") {
        throw new GgbParseError("Root element is not <geogebra>");
    }

    const meta = parseMeta(root);
    const gui = findChild(root, "gui", parseGui);
    const euclidianView = findChild(root, "euclidianView", parseEuclidianView);
    const algebraView = findChild(root, "algebraView", parseAlgebraView);
    const kernel = findChild(root, "kernel", parseKernel);
    const scripting = findChild(root, "scripting", parseScripting);

    let construction: GgbConstruction | undefined;
    const constructionEl = firstChildEl(root, "construction");
    if (constructionEl) {
        construction = parseConstruction(constructionEl);
    }

    if (!construction) {
        throw new GgbParseError("Missing <construction> element");
    }

    return { meta, gui, euclidianView, algebraView, kernel, scripting, construction };
}

// ============================================================
// DOM helpers
// ============================================================

function firstChildEl(parent: XmlElement, tagName: string): XmlElement | null {
    for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        if (child.tagName === tagName) {
            return child;
        }
    }
    return null;
}

function childEls(parent: XmlElement, tagName: string): XmlElement[] {
    const result: XmlElement[] = [];
    for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        if (child.tagName === tagName) {
            result.push(child);
        }
    }
    return result;
}

function findChild<T>(
    parent: XmlElement,
    tagName: string,
    parser: (el: XmlElement) => T
): T | undefined {
    const el = firstChildEl(parent, tagName);
    return el ? parser(el) : undefined;
}

function getAttr(el: XmlElement, name: string): string | undefined {
    const val = el.getAttribute(name);
    return val ?? undefined;
}

function getAttrNum(el: XmlElement, name: string): number | undefined {
    const val = getAttr(el, name);
    if (val === undefined) return undefined;
    const num = Number(val);
    return Number.isFinite(num) ? num : undefined;
}

function getAttrBool(el: XmlElement, name: string): boolean | undefined {
    const val = getAttr(el, name);
    if (val === undefined) return undefined;
    if (val === "true") return true;
    if (val === "false") return false;
    return undefined;
}

// ============================================================
// Meta
// ============================================================

function parseMeta(root: XmlElement): GgbMeta {
    const app = getAttr(root, "app") ?? "graphing";
    return {
        format: getAttr(root, "format") ?? "5.0",
        version: getAttr(root, "version") ?? "",
        app: app as GgbApp,
        subApp: getAttr(root, "subApp"),
        platform: getAttr(root, "platform"),
        id: getAttr(root, "id")
    };
}

// ============================================================
// GUI
// ============================================================

function parseGui(el: XmlElement): GgbGui {
    const gui: GgbGui = {};
    const windowEl = firstChildEl(el, "window");
    if (windowEl) {
        const width = getAttrNum(windowEl, "width");
        const height = getAttrNum(windowEl, "height");
        if (width !== undefined && height !== undefined) {
            gui.window = { width, height };
        }
    }
    const labelingStyle = getAttrNum(el, "labelingStyle") ??
        findChild(el, "labelingStyle", (c) => getAttrNum(c, "val"));
    if (labelingStyle !== undefined) {
        gui.labelingStyle = labelingStyle;
    }
    const fontEl = firstChildEl(el, "font");
    if (fontEl) {
        const size = getAttrNum(fontEl, "size");
        if (size !== undefined) {
            gui.font = { size };
        }
    }
    return gui;
}

// ============================================================
// Euclidian view
// ============================================================

function parseEuclidianView(el: XmlElement): GgbEuclidianView {
    const view: GgbEuclidianView = {};

    const viewNumberEl = firstChildEl(el, "viewNumber");
    if (viewNumberEl) {
        view.viewNumber = getAttrNum(viewNumberEl, "viewNo");
    }

    const sizeEl = firstChildEl(el, "size");
    if (sizeEl) {
        const width = getAttrNum(sizeEl, "width");
        const height = getAttrNum(sizeEl, "height");
        if (width !== undefined && height !== undefined) {
            view.size = { width, height };
        }
    }

    const coordEl = firstChildEl(el, "coordSystem");
    if (coordEl) {
        view.coordSystem = {
            xZero: getAttrNum(coordEl, "xZero"),
            yZero: getAttrNum(coordEl, "yZero"),
            scale: getAttrNum(coordEl, "scale"),
            yscale: getAttrNum(coordEl, "yscale"),
            xMin: getAttrNum(coordEl, "xMin"),
            xMax: getAttrNum(coordEl, "xMax"),
            yMin: getAttrNum(coordEl, "yMin"),
            yMax: getAttrNum(coordEl, "yMax")
        };
    }

    const settingsEl = firstChildEl(el, "evSettings");
    if (settingsEl) {
        view.evSettings = parseEvSettings(settingsEl);
    }

    view.bgColor = findChild(el, "bgColor", parseColor);
    view.axesColor = findChild(el, "axesColor", parseColor);
    view.gridColor = findChild(el, "gridColor", parseColor);

    const axisEls = childEls(el, "axis");
    if (axisEls.length > 0) {
        view.axes = axisEls.map(parseAxis);
    }

    return view;
}

function parseEvSettings(el: XmlElement): GgbEvSettings {
    return {
        axes: getAttrBool(el, "axes") ?? true,
        grid: getAttrBool(el, "grid") ?? false,
        gridIsBold: getAttrBool(el, "gridIsBold"),
        pointCapturing: getAttrNum(el, "pointCapturing"),
        gridType: getAttrNum(el, "gridType"),
        rightAngleStyle: getAttrNum(el, "rightAngleStyle"),
        checkboxSize: getAttrNum(el, "checkboxSize")
    };
}

function parseAxis(el: XmlElement): GgbAxis {
    return {
        id: getAttrNum(el, "id") ?? 0,
        show: getAttrBool(el, "show") ?? true,
        label: getAttr(el, "label"),
        unitLabel: getAttr(el, "unitLabel"),
        tickStyle: getAttrNum(el, "tickStyle"),
        showNumbers: getAttrBool(el, "showNumbers"),
        xTickDistance: getAttrNum(el, "xTickDistance"),
        tickAngle: getAttrNum(el, "tickAngle"),
        axisCross: getAttrNum(el, "axisCross"),
        positiveDirection: getAttrBool(el, "positiveDirection")
    };
}

function parseColor(el: XmlElement): GgbColor {
    return {
        r: getAttrNum(el, "r") ?? 0,
        g: getAttrNum(el, "g") ?? 0,
        b: getAttrNum(el, "b") ?? 0,
        alpha: getAttrNum(el, "alpha")
    };
}

// ============================================================
// Algebra view, kernel, scripting
// ============================================================

function parseAlgebraView(el: XmlElement): GgbAlgebraView {
    const mode = findChild(el, "mode", (c) => getAttrNum(c, "val"));
    return mode !== undefined ? { mode } : {};
}

function parseKernel(el: XmlElement): GgbKernel {
    const kernel: GgbKernel = {};
    const angleUnitEl = firstChildEl(el, "angleUnit");
    if (angleUnitEl) {
        const val = getAttr(angleUnitEl, "val");
        if (val === "degree" || val === "radian" || val === "degreesminutesseconds") {
            kernel.angleUnit = val;
        }
    }
    const algebraStyle = findChild(el, "algebraStyle", (c) => getAttrNum(c, "val"));
    if (algebraStyle !== undefined) kernel.algebraStyle = algebraStyle;
    const coordStyle = findChild(el, "coordStyle", (c) => getAttrNum(c, "val"));
    if (coordStyle !== undefined) kernel.coordStyle = coordStyle;
    const continuous = findChild(el, "continuous", (c) => getAttrBool(c, "val"));
    if (continuous !== undefined) kernel.continuous = continuous;
    const decimals = findChild(el, "decimals", (c) => getAttrNum(c, "val"));
    if (decimals !== undefined) kernel.decimals = decimals;
    const sigfigs = findChild(el, "significantfigures", (c) => getAttrNum(c, "val"));
    if (sigfigs !== undefined) kernel.significantfigures = sigfigs;
    const startAnim = findChild(el, "startAnimation", (c) => getAttrBool(c, "val"));
    if (startAnim !== undefined) kernel.startAnimation = startAnim;
    return kernel;
}

function parseScripting(el: XmlElement): GgbScripting {
    return {
        blocked: getAttrBool(el, "blocked"),
        disabled: getAttrBool(el, "disabled")
    };
}

// ============================================================
// Construction
// ============================================================

function parseConstruction(el: XmlElement): GgbConstruction {
    const construction: GgbConstruction = {
        title: getAttr(el, "title") || undefined,
        author: getAttr(el, "author") || undefined,
        date: getAttr(el, "date") || undefined,
        items: []
    };

    for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        const item = parseConstructionItem(child);
        if (item) {
            construction.items.push(item);
        }
    }

    return construction;
}

function parseConstructionItem(el: XmlElement): GgbConstructionItem | null {
    switch (el.tagName) {
        case "expression":
            return parseExpression(el);
        case "command":
            return parseCommand(el);
        case "element":
            return parseElement(el);
        case "group":
            return parseGroup(el);
        default:
            // Unknown tag — skip silently in Phase 1
            return null;
    }
}

function parseExpression(el: XmlElement): GgbExpression {
    return {
        kind: "expression",
        label: getAttr(el, "label") ?? "",
        exp: getAttr(el, "exp") ?? "",
        type: getAttr(el, "type") as GgbElementType | undefined
    };
}

function parseCommand(el: XmlElement): GgbCommand {
    const name = getAttr(el, "name") ?? "";
    const input: string[] = [];
    const output: string[] = [];
    let outputSizes: string | undefined;

    for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        if (child.tagName === "input") {
            input.push(...parseIndexedArgs(child, "a"));
        } else if (child.tagName === "output") {
            output.push(...parseIndexedArgs(child, "a"));
        } else if (child.tagName === "outputSizes") {
            outputSizes = getAttr(child, "val");
        }
    }

    return {
        kind: "command",
        name,
        input,
        output,
        outputSizes
    };
}

/** Extract indexed attributes a0, a1, a2, ... in order */
function parseIndexedArgs(el: XmlElement, prefix: string): string[] {
    const args: string[] = [];
    let i = 0;
    while (true) {
        const val = getAttr(el, prefix + i);
        if (val === undefined) break;
        args.push(val);
        i++;
    }
    return args;
}

function parseElement(el: XmlElement): GgbElement {
    const element: GgbElement = {
        kind: "element",
        type: (getAttr(el, "type") ?? "point") as GgbElementType,
        label: getAttr(el, "label") ?? ""
    };

    for (let i = 0; i < el.children.length; i++) {
        const child = el.children[i];
        parseElementChild(child, element);
    }

    return element;
}

function parseElementChild(el: XmlElement, element: GgbElement): void {
    switch (el.tagName) {
        case "show":
            element.show = {
                object: getAttrBool(el, "object"),
                label: getAttrBool(el, "label")
            };
            break;
        case "objColor":
            element.objColor = parseColor(el);
            break;
        case "bgColor":
            element.bgColor = parseColor(el);
            break;
        case "borderColor":
            element.borderColor = parseColor(el);
            break;
        case "layer":
            element.layer = getAttrNum(el, "val");
            break;
        case "ordering":
            element.ordering = getAttrNum(el, "val");
            break;
        case "labelMode":
            element.labelMode = getAttrNum(el, "val");
            break;
        case "coords":
            element.coords = parseCoords(el);
            break;
        case "coordStyle":
            element.coordStyle = getAttr(el, "style") as GgbElement["coordStyle"];
            break;
        case "lineStyle":
            element.lineStyle = parseLineStyle(el);
            break;
        case "pointSize":
            element.pointSize = getAttrNum(el, "val");
            break;
        case "pointStyle":
            element.pointStyle = getAttrNum(el, "val");
            break;
        case "eqnStyle":
            element.eqnStyle = getAttr(el, "style");
            break;
        case "fixed":
            element.fixed = getAttrBool(el, "val");
            break;
        case "auxiliary":
            element.auxiliary = getAttrBool(el, "val");
            break;
        case "caption":
            element.caption = getAttr(el, "val");
            break;
        case "decoration":
            element.decoration = { type: getAttrNum(el, "type") ?? 0 };
            break;
        case "animation":
            element.animation = parseAnimation(el);
            break;
        case "slider":
            element.slider = parseSlider(el);
            break;
        case "font":
            element.font = parseFont(el);
            break;
        case "algebra":
            element.algebra = {
                symbolic: getAttrBool(el, "symbolic"),
                type: getAttr(el, "type")
            };
            break;
        case "startPoint":
            element.startPoint = parseCoords(el);
            break;
        case "boundingBox": {
            const x = getAttrNum(el, "x");
            const y = getAttrNum(el, "y");
            const width = getAttrNum(el, "width");
            const height = getAttrNum(el, "height");
            if (x !== undefined && y !== undefined && width !== undefined && height !== undefined) {
                element.boundingBox = { x, y, width, height };
            }
            break;
        }
        case "inBackground":
            element.inBackground = getAttrBool(el, "val");
            break;
        case "listType":
            element.listType = getAttr(el, "val");
            break;
        default:
            // Unknown child tag — skip in Phase 1
            break;
    }
}

function parseCoords(el: XmlElement): GgbCoords {
    return {
        x: getAttrNum(el, "x") ?? 0,
        y: getAttrNum(el, "y") ?? 0,
        z: getAttrNum(el, "z") ?? 1
    };
}

function parseLineStyle(el: XmlElement): GgbLineStyle {
    return {
        thickness: getAttrNum(el, "thickness"),
        type: getAttrNum(el, "type"),
        typeHidden: getAttrNum(el, "typeHidden"),
        opacity: getAttrNum(el, "opacity")
    };
}

function parseAnimation(el: XmlElement): GgbAnimation {
    return {
        step: getAttrNum(el, "step"),
        type: getAttrNum(el, "type"),
        playing: getAttrBool(el, "playing"),
        speed: getAttrNum(el, "speed")
    };
}

function parseSlider(el: XmlElement): GgbSlider {
    return {
        min: getAttrNum(el, "min") ?? 0,
        max: getAttrNum(el, "max") ?? 1,
        step: getAttrNum(el, "step"),
        absolute: getAttrBool(el, "absolute"),
        width: getAttrNum(el, "width"),
        horizontal: getAttrBool(el, "horizontal"),
        showSlider: getAttrBool(el, "showSlider")
    };
}

function parseFont(el: XmlElement): GgbFont {
    return {
        size: getAttrNum(el, "size"),
        isBold: getAttrBool(el, "isBold"),
        isItalic: getAttrBool(el, "isItalic"),
        isSerif: getAttrBool(el, "isSerif")
    };
}

function parseGroup(el: XmlElement): GgbGroup {
    const members: string[] = [];
    let i = 0;
    while (true) {
        const val = getAttr(el, "l" + i);
        if (val === undefined) break;
        members.push(val);
        i++;
    }
    return {
        kind: "group",
        members
    };
}
