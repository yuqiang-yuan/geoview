/**
 * geoview — Renderer type definitions.
 *
 * The renderer takes a parsed GgbDocument and draws it to either a Canvas 2D
 * context (2D mode) or a three.js scene (3D mode). The architecture is
 * backend-agnostic: a common Scene abstraction holds renderable objects,
 * and each backend (Canvas2D / Three3D) traverses it to produce output.
 */

import type * as THREE from "three";
import type {
    GgbColor,
    GgbConstructionItem,
    GgbCoordSystem,
    GgbEuclidianView,
    GgbKernel
} from "./types";

// ============================================================
// Render mode
// ============================================================

export type RenderMode = "2d" | "3d";

// ============================================================
// Viewport — coordinate system state
// ============================================================

/**
 * Viewport maps math/data coordinates to screen coordinates.
 *
 * In 2D mode, it uses the GGB coordSystem (xZero, yZero, scale, yscale).
 * In 3D mode, it stores camera parameters.
 */
export interface Viewport2D {
    mode: "2d";
    /** Pixel position of x=0 */
    xZero: number;
    /** Pixel position of y=0 (note: Canvas y is downward) */
    yZero: number;
    /** Pixels per x-unit */
    scaleX: number;
    /** Pixels per y-unit */
    scaleY: number;
    /** Canvas CSS width */
    width: number;
    /** Canvas CSS height */
    height: number;
}

export interface Viewport3D {
    mode: "3d";
    /** Camera position */
    cameraPos: THREE.Vector3;
    /** Camera target (look-at point) */
    cameraTarget: THREE.Vector3;
    /** Field of view in degrees */
    fov: number;
    /** Near/far clipping planes */
    near: number;
    far: number;
    /** Canvas CSS width */
    width: number;
    /** Canvas CSS height */
    height: number;
}

export type Viewport = Viewport2D | Viewport3D;

// ============================================================
// Color helper
// ============================================================

/** Convert GgbColor to CSS rgba string (GGB alpha 0 = opaque) */
export function ggbColorToCss(color?: GgbColor): string | undefined {
    if (!color) return undefined;
    const a = color.alpha !== undefined ? 1 - color.alpha / 255 : 1;
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${a})`;
}

/** Convert GgbColor to THREE.Color (returns a new instance per call) */
export function ggbColorToThree(color?: GgbColor): { r: number; g: number; b: number } {
    if (!color) return { r: 0, g: 0, b: 0 };
    return { r: color.r / 255, g: color.g / 255, b: color.b / 255 };
}

// ============================================================
// Renderable objects — backend-agnostic scene representation
// ============================================================

/**
 * A renderable is a normalized representation of a GgbConstructionItem,
 * ready for drawing. The parser produces GgbDocument; a "scene builder"
 * pass converts it into Renderable[]; each backend then draws them.
 */

export type Renderable =
    | RenderableFunction
    | RenderablePoint
    | RenderableLine
    | RenderableSegment
    | RenderablePolygon
    | RenderableCircle
    | RenderableText;

/** Common style fields shared by all renderables */
export interface RenderableBase {
    /** Original GGB label */
    label: string;
    /** Whether the object is visible */
    visible: boolean;
    /** Stroke color (CSS or hex) */
    color?: string;
    /** Fill color (for closed shapes) */
    fillColor?: string;
    /** Stroke width in pixels (2D) or world units (3D) */
    strokeWidth?: number;
    /** Line style: 0=solid, 1=dashed, 2=dotted, 3=dash-dot */
    lineStyle?: number;
    /** Opacity 0-1 */
    opacity?: number;
    /** Whether to show the label text */
    showLabel: boolean;
    /** Z-order for rendering (lower = behind) */
    zOrder: number;
}

/** y = f(x) function curve */
export interface RenderableFunction extends RenderableBase {
    kind: "function";
    /** Parsed expression string (e.g. "sin(x)") */
    expression: string;
    /** Angle unit from kernel settings */
    angleUnit: "degree" | "radian";
    /** X range to sample over [xMin, xMax] */
    xRange: [number, number];
    /** Y range of the viewport [yMin, yMax] (for discontinuity detection) */
    yRange: [number, number];
    /** Draw detected vertical asymptotes as dashed lines (default false) */
    showAsymptotes?: boolean;
}

/** A point in 2D or 3D space */
export interface RenderablePoint extends RenderableBase {
    kind: "point";
    /** Position */
    x: number;
    y: number;
    z?: number;
    /** Point size in pixels (2D) */
    pointSize?: number;
    /** Point style: 0=dot, 1=cross, 2=empty circle, ... */
    pointStyle?: number;
}

/** Infinite line: ax + by + c = 0 (2D homogeneous) */
export interface RenderableLine extends RenderableBase {
    kind: "line";
    /** Homogeneous coefficients */
    a: number;
    b: number;
    c: number;
}

/** Line segment between two points */
export interface RenderableSegment extends RenderableBase {
    kind: "segment";
    x1: number;
    y1: number;
    z1?: number;
    x2: number;
    y2: number;
    z2?: number;
}

/** Polygon (closed, filled) */
export interface RenderablePolygon extends RenderableBase {
    kind: "polygon";
    /** Vertices (closed = last connects to first) */
    vertices: Array<{ x: number; y: number; z?: number }>;
}

/** Circle: center + radius */
export interface RenderableCircle extends RenderableBase {
    kind: "circle";
    centerX: number;
    centerY: number;
    centerZ?: number;
    radius: number;
}

/** Text label */
export interface RenderableText extends RenderableBase {
    kind: "text";
    /** Text content */
    content: string;
    /** Anchor position */
    x: number;
    y: number;
    z?: number;
    /** Font size in pixels */
    fontSize?: number;
}

// ============================================================
// Scene — collection of renderables + viewport
// ============================================================

export interface Scene {
    mode: RenderMode;
    viewport: Viewport;
    /** Background color (CSS) */
    bgColor?: string;
    /** Axis color (CSS) */
    axisColor?: string;
    /** Grid color (CSS) */
    gridColor?: string;
    /** Whether to show axes */
    showAxes: boolean;
    /** Whether to show grid */
    showGrid: boolean;
    /** Axes line style: 1 = with arrowheads, 0 = plain */
    axesLineStyle?: number;
    /** Axis definitions */
    axes?: SceneAxis[];
    /** Renderable objects, sorted by zOrder */
    renderables: Renderable[];
    /** Kernel settings (angle unit, decimals, etc.) */
    kernel?: GgbKernel;
}

export interface SceneAxis {
    /** 0=x, 1=y, 2=z */
    id: number;
    show: boolean;
    label?: string;
    unitLabel?: string;
    showNumbers?: boolean;
    tickStyle?: number;
    tickDistance?: number;
    tickExpression?: string;
}

// ============================================================
// Scene builder — GgbDocument → Scene
// ============================================================

/**
 * Build a renderable scene from a parsed document.
 * This is the bridge between parsing and rendering.
 */
export interface SceneBuildOptions {
    /** Force a render mode (auto-detected from document if omitted) */
    mode?: RenderMode;
    /** Canvas width (defaults to view size from document) */
    width?: number;
    /** Canvas height (defaults to view size from document) */
    height?: number;
    /** X range override for function sampling */
    xRange?: [number, number];
    /** Number of samples for function curves */
    nSamples?: number;
    /** Draw detected vertical asymptotes as dashed lines (default false) */
    showAsymptotes?: boolean;
}

// ============================================================
// Renderer backends
// ============================================================

/**
 * 2D renderer — draws to Canvas 2D context.
 */
export interface Renderer2D {
    readonly mode: "2d";
    /** The canvas element */
    canvas: HTMLCanvasElement;
    /** 2D context */
    ctx: CanvasRenderingContext2D;
    /** Device pixel ratio */
    dpr: number;
    /** Render a scene */
    render(scene: Scene): void;
    /** Clear the canvas */
    clear(): void;
    /** Resize canvas */
    resize(width: number, height: number): void;
    /** Pan by pixel delta (dx, dy) */
    pan(dx: number, dy: number): void;
    /** Zoom by factor around a pixel center point */
    zoom(factor: number, centerX?: number, centerY?: number): void;
    /** Get the current viewport */
    getViewport(): Viewport2D;
    /** Set the viewport directly */
    setViewport(vp: Viewport2D): void;
    /** Reset viewport to the original fit */
    resetView(): void;
    /** Clean up resources */
    dispose(): void;
}

/**
 * 3D renderer — draws to a three.js WebGL scene.
 */
export interface Renderer3D {
    readonly mode: "3d";
    /** The canvas element */
    canvas: HTMLCanvasElement;
    /** three.js renderer */
    threeRenderer: THREE.WebGLRenderer;
    /** three.js scene */
    threeScene: THREE.Scene;
    /** three.js camera */
    camera: THREE.PerspectiveCamera;
    /** Render a scene */
    render(scene: Scene): void;
    /** Clear the scene */
    clear(): void;
    /** Resize canvas and camera aspect */
    resize(width: number, height: number): void;
    /** Clean up resources (dispose geometries, materials, renderer) */
    dispose(): void;
}

/** Union of all renderer backends */
export type Renderer = Renderer2D | Renderer3D;

// ============================================================
// Label rendering (open for caller customisation)
// ============================================================

/**
 * Custom label renderer return type:
 * - string: the renderer draws with `ctx.fillText`
 * - HTMLImageElement | HTMLCanvasElement: the renderer draws with `ctx.drawImage`
 *
 * Callers can use MathJax/KaTeX to render LaTeX into an image first,
 * then return it. The library doesn't care how text is generated —
 * it only positions and draws the result.
 */
export type LabelRenderResult = string | HTMLImageElement | HTMLCanvasElement;

/**
 * Label/text style options passed to {@link LabelRenderer}.
 */
export interface LabelOptions {
    /** Font size in CSS pixels */
    fontSize?: number;
    /** CSS color string */
    color?: string;
    /** Horizontal alignment relative to the anchor point */
    align?: "start" | "middle" | "end";
    /** Vertical alignment relative to the anchor point */
    baseline?: "top" | "middle" | "bottom" | "alphabetic";
    /** Italic style (for axis labels like *x*, *y*) */
    italic?: boolean;
}

/**
 * Custom label renderer.
 *
 * Called by the renderer whenever text needs to be drawn (axis labels,
 * tick numbers, function labels, text objects). If not provided,
 * the renderer falls back to `ctx.fillText` with plain text.
 *
 * @param text  raw text content (may contain LaTeX, interpreted by caller)
 * @param opts  style options
 * @returns     render result (image/canvas/plain text), may be async
 */
export type LabelRenderer = (
    text: string,
    opts?: LabelOptions
) => LabelRenderResult | Promise<LabelRenderResult>;

// ============================================================
// Renderer factory
// ============================================================

export interface RendererOptions {
    /** Render mode (auto-detected if omitted) */
    mode?: RenderMode;
    /** Canvas element to render to */
    canvas: HTMLCanvasElement;
    /** Width in CSS pixels */
    width?: number;
    /** Height in CSS pixels */
    height?: number;
    /** Custom label renderer (e.g. MathJax/KaTeX) */
    labelRenderer?: LabelRenderer;
    /** Device pixel ratio (defaults to window.devicePixelRatio) */
    dpr?: number;
}

// ============================================================
// Sampler — evaluates function expressions
// ============================================================

/** A sampled polyline segment (continuous run of points) */
export interface PolylineSegment {
    points: Array<{ x: number; y: number; z?: number }>;
}

/** Result of sampling a function: segments plus detected asymptotes. */
export interface SampleResult {
    /** Continuous polyline segments */
    segments: PolylineSegment[];
    /** X positions of detected vertical asymptotes */
    asymptotes: number[];
}

/**
 * Sampler takes an expression string and produces polyline segments
 * plus detected vertical asymptote positions.
 */
export interface SamplerFn {
    (
        expression: string,
        params: SamplerParams
    ): SampleResult;
}

export interface SamplerParams {
    /** X range to sample over */
    xRange: [number, number];
    /** Y range of the viewport (for discontinuity detection) */
    yRange: [number, number];
    /** Angle unit */
    angleUnit: "degree" | "radian";
    /** Number of samples (fallback when pixelWidth is unknown) */
    nSamples: number;
    /** Pixel width (drives sampling density: 2 samples per pixel column) */
    pixelWidth: number;
    /** Pixel height (used for pixel-space discontinuity detection) */
    pixelHeight?: number;
}

// ============================================================
// High-level public API
// ============================================================

/**
 * Render a parsed GgbDocument to a canvas.
 *
 * Auto-detects 2D vs 3D from the document content, builds a Scene,
 * and renders it using the appropriate backend.
 *
 * @param doc — parsed GgbDocument
 * @param canvas — target canvas element
 * @param options — optional configuration
 * @returns the renderer instance (for further control)
 */
export interface RenderGgbOptions {
    /** Force render mode */
    mode?: RenderMode;
    /** Canvas width (defaults to canvas client size) */
    width?: number;
    /** Canvas height (defaults to canvas client size) */
    height?: number;
    /** Device pixel ratio */
    dpr?: number;
    /** Sample count for function curves (fallback without pixel metrics) */
    nSamples?: number;
    /** Draw detected vertical asymptotes as dashed lines (default false) */
    showAsymptotes?: boolean;
    /** Custom label renderer (e.g. MathJax/KaTeX) */
    labelRenderer?: LabelRenderer;
}
