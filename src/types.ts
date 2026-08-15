/**
 * geoview — Type definitions for .ggb file parsing.
 *
 * These types represent the intermediate representation (IR) produced
 * by the parser. They mirror the structure of the GeoGebra XML format
 * without depending on any GeoGebra code.
 */

// ============================================================
// Archive layer — raw files extracted from the .ggb ZIP
// ============================================================

export interface GgbArchive {
    /** geogebra.xml content (decoded as UTF-8 string) */
    xml: string;
    /** geogebra_thumbnail.png (raw bytes, if present) */
    thumbnail?: Uint8Array;
    /** geogebra_javascript.js (decoded as UTF-8, if present) */
    javascript?: string;
    /** All files in the archive, keyed by filename */
    files: Record<string, Uint8Array>;
}

// ============================================================
// Document root
// ============================================================

export interface GgbDocument {
    meta: GgbMeta;
    gui?: GgbGui;
    euclidianView?: GgbEuclidianView;
    algebraView?: GgbAlgebraView;
    kernel?: GgbKernel;
    scripting?: GgbScripting;
    construction: GgbConstruction;
}

export interface GgbMeta {
    format: string;
    version: string;
    app: GgbApp;
    subApp?: string;
    platform?: string;
    id?: string;
}

export type GgbApp =
    | "graphing"
    | "geometry"
    | "classic"
    | "3d"
    | "scientific"
    | "suite"
    | "cas"
    | "notes"
    | "probability";

// ============================================================
// View settings
// ============================================================

export interface GgbGui {
    window?: { width: number; height: number };
    labelingStyle?: number;
    font?: { size: number };
}

export interface GgbEuclidianView {
    viewNumber?: number;
    size?: { width: number; height: number };
    coordSystem?: GgbCoordSystem;
    evSettings?: GgbEvSettings;
    bgColor?: GgbColor;
    axesColor?: GgbColor;
    gridColor?: GgbColor;
    /** Axes line style from <lineStyle axes="1" grid="0"/>: 1=arrow, 0=plain */
    axesLineStyle?: number;
    /** Grid line style from <lineStyle axes="1" grid="0"/>: 0=plain, etc. */
    gridLineStyle?: number;
    axes?: GgbAxis[];
}

export interface GgbCoordSystem {
    /** Pixel origin (x = 0 axis position in pixels) */
    xZero?: number;
    /** Pixel origin (y = 0 axis position in pixels) */
    yZero?: number;
    /** Pixels per x-unit */
    scale?: number;
    /** Pixels per y-unit (defaults to scale if omitted) */
    yscale?: number;
    /** Bounds-based coordinate range */
    xMin?: number;
    xMax?: number;
    yMin?: number;
    yMax?: number;
}

export interface GgbEvSettings {
    axes: boolean;
    grid: boolean;
    gridIsBold?: boolean;
    pointCapturing?: number;
    gridType?: number;
    rightAngleStyle?: number;
    checkboxSize?: number;
}

export interface GgbAxis {
    /** 0 = x-axis, 1 = y-axis, 2 = z-axis (3D) */
    id: number;
    show: boolean;
    label?: string;
    unitLabel?: string;
    tickStyle?: number;
    showNumbers?: boolean;
    tickDistance?: number;
    tickExpression?: string;
    tickAngle?: number;
    axisCross?: number;
    positiveDirection?: boolean;
}

export interface GgbAlgebraView {
    mode?: number;
}

export interface GgbKernel {
    angleUnit?: "degree" | "radian" | "degreesminutesseconds";
    algebraStyle?: number;
    coordStyle?: number;
    continuous?: boolean;
    decimals?: number;
    significantfigures?: number;
    startAnimation?: boolean;
}

export interface GgbScripting {
    blocked?: boolean;
    disabled?: boolean;
}

// ============================================================
// Construction — core geometric data
// ============================================================

export interface GgbConstruction {
    title?: string;
    author?: string;
    date?: string;
    /** Construction items in XML document order (order matters for dependencies) */
    items: GgbConstructionItem[];
}

export type GgbConstructionItem =
    | GgbExpression
    | GgbCommand
    | GgbElement
    | GgbGroup;

/** Independent object defined by an algebraic expression */
export interface GgbExpression {
    kind: "expression";
    label: string;
    /** GeoGebra expression string (e.g. "f(x) = sin(x)") */
    exp: string;
    /** Optional forced type */
    type?: GgbElementType;
}

/** Dependent object created by a GeoGebra command */
export interface GgbCommand {
    kind: "command";
    /** Command name (e.g. "Line", "Circle", "Polygon") */
    name: string;
    /** Input arguments — label references or expression strings */
    input: string[];
    /** Output object labels */
    output: string[];
    /** Optional output sizes for multi-type commands */
    outputSizes?: string;
}

/** Element properties — visual and geometric attributes */
export interface GgbElement {
    kind: "element";
    type: GgbElementType;
    label: string;
    show?: { object?: boolean; label?: boolean };
    objColor?: GgbColor;
    bgColor?: GgbColor;
    borderColor?: GgbColor;
    layer?: number;
    ordering?: number;
    labelMode?: number;
    coords?: GgbCoords;
    coordStyle?: "cartesian" | "polar" | "complex" | "cartesian3d" | "spherical";
    lineStyle?: GgbLineStyle;
    pointSize?: number;
    pointStyle?: number;
    eqnStyle?: string;
    fixed?: boolean;
    auxiliary?: boolean;
    caption?: string;
    decoration?: { type: number };
    /**
     * Conic matrix from <matrix A0..A5> - the symmetric 3x3 homogeneous
     * matrix in GeoGebra's packed layout:
     *   M = [[A0,A3,A4],[A3,A1,A5],[A4,A5,A2]]
     * i.e. A0*x^2 + 2*A3*xy + A1*y^2 + 2*A4*x + 2*A5*y + A2 = 0
     */
    matrix?: GgbConicMatrix;
    /** Whether a text object's content is LaTeX (<isLaTeX val="true"/>) */
    isLaTeX?: boolean;
    animation?: GgbAnimation;
    slider?: GgbSlider;
    font?: GgbFont;
    algebra?: { symbolic?: boolean; type?: string };
    startPoint?: GgbCoords;
    boundingBox?: { x: number; y: number; width: number; height: number };
    inBackground?: boolean;
    listType?: string;
}

/** Object group */
export interface GgbGroup {
    kind: "group";
    /** Labels of grouped objects */
    members: string[];
}

// ============================================================
// Element types
// ============================================================

export type GgbElementType =
    // Geometric primitives
    | "point"
    | "line"
    | "segment"
    | "ray"
    | "vector"
    | "polygon"
    | "polyline"
    // Conics
    | "conic"
    | "circle"
    | "ellipse"
    | "parabola"
    | "hyperbola"
    | "doubleLine"
    | "intersectinglines"
    | "parallellines"
    | "emtpyset"
    | "conicpart"
    // Functions
    | "function"
    | "functionconditional"
    | "functionnvar"
    | "curvecartesian"
    | "surfacecartesian"
    | "implicitpoly"
    | "interval"
    // Data types
    | "numeric"
    | "angle"
    | "boolean"
    | "list"
    | "locus"
    // Text / media
    | "text"
    | "inlinetext"
    | "image"
    | "audio"
    | "video"
    | "embed"
    // Interactive
    | "button"
    | "textfield"
    | "formula"
    // Other
    | "cascell"
    | "penstroke"
    | "mindmap"
    | "table";

// ============================================================
// Style sub-types
// ============================================================

/** Homogeneous coordinates: points use (x, y, 1), lines use (a, b, c) for ax+by+c=0 */
export interface GgbCoords {
    x: number;
    y: number;
    z: number;
}

/**
 * Conic matrix packed as A0..A5 (GeoGebra's <matrix> element).
 * Symmetric layout: M = [[A0,A3,A4],[A3,A1,A5],[A4,A5,A2]].
 */
export interface GgbConicMatrix {
    A0: number;
    A1: number;
    A2: number;
    A3: number;
    A4: number;
    A5: number;
}

export interface GgbColor {
    r: number;
    g: number;
    b: number;
    /** Alpha 0-255 (0 = opaque in GeoGebra's convention) */
    alpha?: number;
}

export interface GgbLineStyle {
    thickness?: number;
    /** 0 = solid, 1 = dashed, etc. */
    type?: number;
    typeHidden?: number;
    opacity?: number;
}

export interface GgbAnimation {
    step?: number;
    type?: number;
    playing?: boolean;
    speed?: number;
}

export interface GgbSlider {
    min: number;
    max: number;
    step?: number;
    absolute?: boolean;
    width?: number;
    horizontal?: boolean;
    showSlider?: boolean;
}

export interface GgbFont {
    size?: number;
    /** Font size multiplier (<font sizeM="1"/>); size=0 means sizeM x default */
    sizeM?: number;
    isBold?: boolean;
    isItalic?: boolean;
    isSerif?: boolean;
}

// ============================================================
// Parse options + errors
// ============================================================

export interface GgbParseOptions {
    /** Include raw XML attributes not yet mapped to typed fields */
    includeRaw?: boolean;
}

export class GgbParseError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = "GgbParseError";
    }
}
