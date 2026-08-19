/**
 * geoview — Canvas 2D renderer.
 *
 * Draws a Scene to an HTML5 Canvas 2D context. Handles:
 * - Background fill
 * - Grid lines
 * - Axes with tick marks and numbers
 * - Function curves (sampled via mathjs)
 * - Other renderable types (point, line, segment, polygon, circle, text)
 *
 * Supports interactive pan (drag) and zoom (wheel) by maintaining
 * a mutable viewport that is updated in place and re-rendered.
 *
 * Labels can be customised via a {@link LabelRenderer} callback —
 * callers can use MathJax/KaTeX to render LaTeX into images.
 */

import type {
    LabelOptions,
    LabelRenderResult,
    LabelRenderer,
    Renderable,
    RenderableConic,
    RenderableFunction,
    RenderablePoint,
    RenderablePointList,
    RenderableLine,
    RenderableSegment,
    RenderablePolygon,
    RenderableCircle,
    RenderableSlider,
    RenderableText,
    Renderer2D,
    Scene,
    SceneAxis,
    Viewport2D
} from "./render-types";
import { builtinSampler } from "./sampler";
import { sampleConic } from "./conic";

// Default colors
const DEFAULT_BG = "#ffffff";
const DEFAULT_AXIS = "#1c1c1f";
const DEFAULT_GRID = "#b4b3ba";
const DEFAULT_FUNC = "#006758";

const DEFAULT_SAMPLES = 800;

/** A label draw task — collected during sync render, drawn async. */
interface LabelTask {
    text: string;
    x: number;
    y: number;
    opts: LabelOptions;
}

/**
 * Create a Canvas 2D renderer.
 */
export function createRenderer2D(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    dpr: number = typeof window !== "undefined"
        ? window.devicePixelRatio || 1
        : 1,
    labelRenderer?: LabelRenderer
): Renderer2D {
    const ctx = canvas.getContext("2d")!;

    // Mutable viewport — updated by pan/zoom, used for all rendering
    let viewport: Viewport2D = {
        mode: "2d",
        xZero: width / 2,
        yZero: height / 2,
        scaleX: 50,
        scaleY: 50,
        width,
        height
    };

    // The initial viewport from the first render() call (for resetView)
    let initialViewport: Viewport2D | undefined;

    // The last scene passed to render() — used for re-render on pan/zoom
    let currentScene: Scene | undefined;

    // Token to cancel stale async label rendering
    let renderToken = 0;

    function setupCanvas() {
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setupCanvas();

    /**
     * Internal: render a scene with the current viewport.
     * Function renderables are re-sampled using the current visible
     * data range so curves stay accurate when zoomed/panned.
     *
     * If a labelRenderer is provided, label drawing is deferred to
     * after the sync pass (labels may be async via MathJax etc.).
     */
    function doRender(scene: Scene, vp: Viewport2D): void {
        const w = vp.width;
        const h = vp.height;

        // Clear
        ctx.clearRect(0, 0, w, h);
        // Background
        ctx.fillStyle = scene.bgColor ?? DEFAULT_BG;
        ctx.fillRect(0, 0, w, h);

        // Collect label tasks for async pass
        const labelTasks: LabelTask[] = [];

        // GeoGebra rounding setting (decimals) drives number formatting.
        const decimals = scene.kernel?.decimals;

        // Grid
        if (scene.showGrid) {
            drawGrid(ctx, vp, scene.gridColor ?? DEFAULT_GRID);
        }

        // Axes
        if (scene.showAxes) {
            drawAxes(ctx, vp, scene, labelTasks, decimals);
        }

        // Compute current visible data range for function re-sampling
        const visXMin = dataX(vp, 0);
        const visXMax = dataX(vp, w);
        const visYMin = dataY(vp, h);
        const visYMax = dataY(vp, 0);

        // Renderables
        for (const r of scene.renderables) {
            if (!r.visible) continue;
            if (r.kind === "function") {
                drawFunction(ctx, r, vp, visXMin, visXMax, visYMin, visYMax, labelTasks);
            } else if (r.kind === "conic") {
                drawConic(ctx, r, vp, visXMin, visXMax, visYMin, visYMax, labelTasks);
            } else {
                drawRenderable(ctx, r, vp, labelTasks, decimals);
            }
        }

        // Async label pass
        if (labelTasks.length > 0) {
            const token = ++renderToken;
            drawLabelsAsync(labelTasks, token);
        }
    }

    /**
     * Draw collected labels. Uses labelRenderer if provided, otherwise
     * falls back to ctx.fillText. A render token cancels stale renders.
     */
    async function drawLabelsAsync(tasks: LabelTask[], token: number): Promise<void> {
        for (const task of tasks) {
            // Cancelled by a newer render
            if (token !== renderToken) return;

            if (labelRenderer) {
                try {
                    const result = await labelRenderer(task.text, task.opts);
                    if (token !== renderToken) return;
                    drawLabelResult(ctx, result, task.x, task.y, task.opts);
                } catch {
                    // Fall back to plain text on error
                    drawLabelFallback(ctx, task.text, task.x, task.y, task.opts);
                }
            } else {
                drawLabelFallback(ctx, task.text, task.x, task.y, task.opts);
            }
        }
    }

    return {
        mode: "2d",
        canvas,
        ctx,
        dpr,

        render(scene: Scene): void {
            currentScene = scene;
            // Adopt the scene's viewport as our current viewport
            viewport = { ...scene.viewport as Viewport2D };
            if (!initialViewport) {
                initialViewport = { ...viewport };
            }
            doRender(scene, viewport);
        },

        updateScene(scene: Scene): void {
            // Re-render with a new scene WITHOUT resetting the viewport —
            // interactive rebuilds (e.g. after dragging a slider) must
            // preserve the current pan/zoom, unlike the initial render().
            currentScene = scene;
            doRender(scene, viewport);
        },

        clear(): void {
            ctx.clearRect(0, 0, width, height);
        },

        resize(newWidth: number, newHeight: number): void {
            const oldVp = { ...viewport };
            width = newWidth;
            height = newHeight;
            setupCanvas();
            // Keep the same data center, adjust pixel dimensions
            viewport = {
                ...oldVp,
                width: newWidth,
                height: newHeight,
                // Re-center origin proportionally
                xZero: newWidth / 2 - (oldVp.width / 2 - oldVp.xZero),
                yZero: newHeight / 2 - (oldVp.height / 2 - oldVp.yZero)
            };
            if (currentScene) {
                doRender(currentScene, viewport);
            }
        },

        pan(dx: number, dy: number): void {
            viewport = {
                ...viewport,
                xZero: viewport.xZero + dx,
                yZero: viewport.yZero + dy
            };
            if (currentScene) {
                doRender(currentScene, viewport);
            }
        },

        zoom(factor: number, centerX?: number, centerY?: number): void {
            // Default zoom center = canvas center
            const cx = centerX ?? viewport.width / 2;
            const cy = centerY ?? viewport.height / 2;

            // The data point under (cx, cy) should stay fixed after zoom.
            // Before zoom: dataX = (cx - xZero) / scaleX
            // After zoom:  we want (cx - newXZero) / newScaleX = same dataX
            //   => newXZero = cx - dataX * newScaleX
            const dxVal = (cx - viewport.xZero) / viewport.scaleX;
            const dyVal = (cy - viewport.yZero) / viewport.scaleY;

            const newScaleX = viewport.scaleX * factor;
            const newScaleY = viewport.scaleY * factor;

            viewport = {
                ...viewport,
                scaleX: newScaleX,
                scaleY: newScaleY,
                xZero: cx - dxVal * newScaleX,
                yZero: cy - dyVal * newScaleY
            };
            if (currentScene) {
                doRender(currentScene, viewport);
            }
        },

        getViewport(): Viewport2D {
            return { ...viewport };
        },

        setViewport(vp: Viewport2D): void {
            viewport = { ...vp };
            if (currentScene) {
                doRender(currentScene, viewport);
            }
        },

        resetView(): void {
            if (initialViewport) {
                viewport = { ...initialViewport };
                if (currentScene) {
                    doRender(currentScene, viewport);
                }
            }
        },

        dispose(): void {
            // Canvas 2D has no resources to dispose
        }
    };
}

// ============================================================
// Label drawing helpers
// ============================================================

/**
 * Draw a label result (string / image / canvas) at the given position.
 */
function drawLabelResult(
    ctx: CanvasRenderingContext2D,
    result: LabelRenderResult,
    x: number,
    y: number,
    opts: LabelOptions
): void {
    if (typeof result === "string") {
        drawLabelFallback(ctx, result, x, y, opts);
    } else {
        // Image or Canvas — draw with drawImage
        const w = result.width;
        const h = result.height;
        let dx = x;
        let dy = y;
        const align = opts.align ?? "start";
        const baseline = opts.baseline ?? "alphabetic";
        if (align === "middle") dx -= w / 2;
        else if (align === "end") dx -= w;
        if (baseline === "middle") dy -= h / 2;
        else if (baseline === "bottom") dy -= h;
        // For "top" and "alphabetic", draw from top
        ctx.drawImage(result, dx, dy);
    }
}

/**
 * Fallback: draw text with ctx.fillText.
 */
function drawLabelFallback(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    opts: LabelOptions
): void {
    const fontSize = opts.fontSize ?? 13;
    const italic = opts.italic ? "italic " : "";
    const serif = opts.serif ? "serif" : "sans-serif";
    ctx.font = `${italic}${fontSize}px ${serif}`;
    ctx.fillStyle = opts.color ?? "#1c1c1f";
    // Map LabelOptions align → Canvas textAlign
    const alignMap: Record<string, CanvasTextAlign> = {
        start: "left",
        middle: "center",
        end: "right"
    };
    ctx.textAlign = alignMap[opts.align ?? "start"] ?? "left";
    ctx.textBaseline = opts.baseline ?? "alphabetic";
    // Strip LaTeX inline delimiters for plain-text fallback rendering
    const stripped = text.replace(/^\\\((.*)\\\)$/s, "$1");
    ctx.fillText(stripped, x, y);
}

// ============================================================
// Grid
// ============================================================

function drawGrid(
    ctx: CanvasRenderingContext2D,
    vp: Viewport2D,
    color: string
): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();

    // Determine grid spacing in data units (aim for ~50px between grid lines)
    const xGridStep = niceStep(50 / vp.scaleX);
    const yGridStep = niceStep(50 / vp.scaleY);

    const xMin = dataX(vp, 0);
    const xMax = dataX(vp, vp.width);
    const yMin = dataY(vp, vp.height);
    const yMax = dataY(vp, 0);

    // Vertical grid lines
    const xStart = Math.ceil(xMin / xGridStep) * xGridStep;
    for (let x = xStart; x <= xMax; x += xGridStep) {
        const px = pixelX(vp, x);
        ctx.moveTo(px, 0);
        ctx.lineTo(px, vp.height);
    }

    // Horizontal grid lines
    const yStart = Math.ceil(yMin / yGridStep) * yGridStep;
    for (let y = yStart; y <= yMax; y += yGridStep) {
        const py = pixelY(vp, y);
        ctx.moveTo(0, py);
        ctx.lineTo(vp.width, py);
    }

    ctx.stroke();
}

/**
 * Find a "nice" grid step (1, 2, 5, 10, 20, 50, ...).
 */
function niceStep(raw: number): number {
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const norm = raw / base;
    let step: number;
    if (norm < 1.5) step = 1;
    else if (norm < 3.5) step = 2;
    else if (norm < 7.5) step = 5;
    else step = 10;
    return step * base;
}

/**
 * Ensure a tick step produces at least `minPx` pixels between ticks.
 * Multiplies the base step by 1/2/5/10/... until the pixel spacing
 * is sufficient. This keeps tickDistance as the "unit" but prevents
 * overcrowding when zoomed out.
 */
function ensureMinSpacing(
    baseStep: number,
    scale: number,
    minPx: number
): number {
    const basePx = baseStep * scale;
    if (basePx >= minPx) return baseStep;
    // Multiply by powers of 10, trying 1/2/5 multipliers at each level
    let mult = 1;
    const candidates = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    for (const c of candidates) {
        if (baseStep * c * scale >= minPx) {
            mult = c;
            break;
        }
        mult = c;
    }
    return baseStep * mult;
}

// ============================================================
// Axes
// ============================================================

function drawAxes(
    ctx: CanvasRenderingContext2D,
    vp: Viewport2D,
    scene: Scene,
    labelTasks: LabelTask[],
    decimals?: number
): void {
    const color = scene.axisColor ?? DEFAULT_AXIS;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;

    const hasArrows = scene.axesLineStyle === 1;
    const xAxis = scene.axes?.find((a) => a.id === 0);
    const yAxis = scene.axes?.find((a) => a.id === 1);

    // X axis (y = 0)
    const y0 = pixelY(vp, 0);
    if (y0 >= 0 && y0 <= vp.height) {
        ctx.beginPath();
        ctx.moveTo(0, y0);
        ctx.lineTo(vp.width, y0);
        ctx.stroke();

        if (hasArrows) {
            drawArrowHead(ctx, vp.width, y0, 0);
        }

        drawXTicks(ctx, vp, scene, y0, xAxis, labelTasks, decimals);

        // Axis label (e.g. "x")
        if (xAxis?.label) {
            labelTasks.push({
                text: xAxis.label,
                x: vp.width - 8,
                y: y0 - 6,
                opts: {
                    fontSize: 14,
                    color,
                    align: "end",
                    baseline: "bottom",
                    italic: true
                }
            });
        }
    }

    // Y axis (x = 0)
    const x0 = pixelX(vp, 0);
    if (x0 >= 0 && x0 <= vp.width) {
        ctx.beginPath();
        ctx.moveTo(x0, 0);
        ctx.lineTo(x0, vp.height);
        ctx.stroke();

        if (hasArrows) {
            drawArrowHead(ctx, x0, 0, -Math.PI / 2);
        }

        drawYTicks(ctx, vp, scene, x0, yAxis, labelTasks, decimals);

        // Axis label (e.g. "y")
        if (yAxis?.label) {
            labelTasks.push({
                text: yAxis.label,
                x: x0 + 6,
                y: 8,
                opts: {
                    fontSize: 14,
                    color,
                    align: "start",
                    baseline: "top",
                    italic: true
                }
            });
        }
    }
}

/**
 * Draw an arrowhead at (x, y) pointing in the direction `angle` (radians).
 * Default points right (along +x axis).
 */
function drawArrowHead(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number = 0
): void {
    const size = 8;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size / 2);
    ctx.lineTo(-size, size / 2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function drawXTicks(
    ctx: CanvasRenderingContext2D,
    vp: Viewport2D,
    scene: Scene,
    y0: number,
    axis: SceneAxis | undefined,
    labelTasks: LabelTask[],
    decimals?: number
): void {
    // Use tickDistance as the base step, but ensure a minimum pixel
    // spacing (~40px) by multiplying up when zoomed out.
    const baseStep = axis?.tickDistance ?? niceStep(50 / vp.scaleX);
    const step = ensureMinSpacing(baseStep, vp.scaleX, 40);

    const xMin = dataX(vp, 0);
    const xMax = dataX(vp, vp.width);
    const showNumbers = axis?.showNumbers ?? true;
    const color = scene.axisColor ?? DEFAULT_AXIS;

    const xStart = Math.ceil(xMin / step) * step;
    for (let x = xStart; x <= xMax; x += step) {
        if (Math.abs(x) < 1e-10) continue; // skip origin
        const px = pixelX(vp, x);
        // Tick mark
        ctx.beginPath();
        ctx.moveTo(px, y0 - 3);
        ctx.lineTo(px, y0 + 3);
        ctx.stroke();
        // Label
        if (showNumbers) {
            labelTasks.push({
                text: formatNumber(x, decimals),
                x: px,
                y: y0 + 5,
                opts: {
                    fontSize: 12,
                    color,
                    align: "middle",
                    baseline: "top"
                }
            });
        }
    }
}

function drawYTicks(
    ctx: CanvasRenderingContext2D,
    vp: Viewport2D,
    scene: Scene,
    x0: number,
    axis: SceneAxis | undefined,
    labelTasks: LabelTask[],
    decimals?: number
): void {
    // Use tickDistance as the base step, but ensure a minimum pixel
    // spacing (~40px) by multiplying up when zoomed out.
    const baseStep = axis?.tickDistance ?? niceStep(50 / vp.scaleY);
    const step = ensureMinSpacing(baseStep, vp.scaleY, 40);

    const yMin = dataY(vp, vp.height);
    const yMax = dataY(vp, 0);
    const showNumbers = axis?.showNumbers ?? true;
    const color = scene.axisColor ?? DEFAULT_AXIS;

    const yStart = Math.ceil(yMin / step) * step;
    for (let y = yStart; y <= yMax; y += step) {
        if (Math.abs(y) < 1e-10) continue; // skip origin
        const py = pixelY(vp, y);
        // Tick mark
        ctx.beginPath();
        ctx.moveTo(x0 - 3, py);
        ctx.lineTo(x0 + 3, py);
        ctx.stroke();
        // Label
        if (showNumbers) {
            labelTasks.push({
                text: formatNumber(y, decimals),
                x: x0 - 5,
                y: py,
                opts: {
                    fontSize: 12,
                    color,
                    align: "end",
                    baseline: "middle"
                }
            });
        }
    }
}

/**
 * Format a number for display. When `decimals` is given (GeoGebra's
 * rounding setting), round to that many decimal places and trim trailing
 * zeros so integers stay clean. Otherwise fall back to 6 significant
 * figures with exponential notation for very large/small magnitudes.
 */
function formatNumber(n: number, decimals?: number): string {
    if (Math.abs(n) < 1e-10) return "0";
    if (decimals !== undefined && decimals >= 0) {
        const fixed = n.toFixed(decimals).replace(/\.?0+$/, "");
        return fixed === "" ? "0" : fixed;
    }
    if (Math.abs(n) >= 1000 || Math.abs(n) < 0.001) {
        return n.toExponential(1);
    }
    return parseFloat(n.toPrecision(6)).toString();
}

// ============================================================
// Coordinate transforms
// ============================================================

/** Data x → pixel x */
function pixelX(vp: Viewport2D, x: number): number {
    return vp.xZero + x * vp.scaleX;
}

/** Data y → pixel y (Canvas y is downward) */
function pixelY(vp: Viewport2D, y: number): number {
    return vp.yZero - y * vp.scaleY;
}

/** Pixel x → data x */
function dataX(vp: Viewport2D, px: number): number {
    return (px - vp.xZero) / vp.scaleX;
}

/** Pixel y → data y */
function dataY(vp: Viewport2D, py: number): number {
    return (vp.yZero - py) / vp.scaleY;
}

// ============================================================
// Renderable drawing
// ============================================================

function drawRenderable(
    ctx: CanvasRenderingContext2D,
    r: Renderable,
    vp: Viewport2D,
    labelTasks: LabelTask[],
    decimals?: number
): void {
    switch (r.kind) {
        case "function":
            // Should not reach here — functions are drawn via drawFunction
            break;
        case "point":
            drawPoint(ctx, r, vp, labelTasks);
            break;
        case "pointlist":
            drawPointList(ctx, r, vp);
            break;
        case "line":
            drawLine(ctx, r, vp, labelTasks);
            break;
        case "segment":
            drawSegment(ctx, r, vp);
            break;
        case "polygon":
            drawPolygon(ctx, r, vp);
            break;
        case "circle":
            drawCircle(ctx, r, vp);
            break;
        case "text":
            drawText(ctx, r, vp, labelTasks);
            break;
        case "slider":
            drawSlider(ctx, r, vp, labelTasks, decimals);
            break;
    }
}

function setLineStyle(
    ctx: CanvasRenderingContext2D,
    style?: number,
    thickness?: number
): void {
    // GGB thickness (1-13) maps to Canvas pixels with a 0.4 factor,
    // clamped to a minimum of 1px so thin lines stay visible.
    ctx.lineWidth = thickness !== undefined
        ? Math.max(1, thickness * 0.4)
        : 1;
    // GGB line style type mapping:
    // 0 = solid, 1 = short dash, 2 = dotted, 3 = dash-dot,
    // 4 = long dash, 5 = dense dash, 10 = hidden,
    // 15 = dashed (long), other high values = various dash patterns
    switch (style) {
        case 1:
            ctx.setLineDash([6, 4]);
            break;
        case 2:
            ctx.setLineDash([2, 4]);
            break;
        case 3:
            ctx.setLineDash([8, 4, 2, 4]);
            break;
        case 4:
            ctx.setLineDash([12, 4]);
            break;
        case 5:
            ctx.setLineDash([4, 2]);
            break;
        case 15:
            ctx.setLineDash([10, 5]);
            break;
        case 0:
        case undefined:
        default:
            ctx.setLineDash([]);
            break;
    }
}

function drawFunction(
    ctx: CanvasRenderingContext2D,
    r: RenderableFunction,
    vp: Viewport2D,
    visXMin: number,
    visXMax: number,
    visYMin: number,
    visYMax: number,
    labelTasks: LabelTask[]
): void {
    // Use the visible data range for sampling, so curves are accurate
    // at any zoom level. Fall back to the renderable's stored range.
    const xRange: [number, number] = [
        Math.min(r.xRange[0], visXMin),
        Math.max(r.xRange[1], visXMax)
    ];
    const yRange: [number, number] = [visYMin, visYMax];

    const result = builtinSampler(r.expression, {
        xRange,
        yRange,
        angleUnit: r.angleUnit,
        nSamples: DEFAULT_SAMPLES,
        pixelWidth: vp.width,
        pixelHeight: vp.height,
        scope: r.scope
    });
    const segments = result.segments;

    ctx.strokeStyle = r.color ?? DEFAULT_FUNC;
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 3);
    if (r.opacity !== undefined) {
        ctx.globalAlpha = r.opacity;
    }

    // Clip to the canvas bounds so curves near asymptotes that have
    // large y values don't draw as long vertical lines across the screen.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vp.width, vp.height);
    ctx.clip();

    ctx.beginPath();
    for (const seg of segments) {
        if (seg.points.length < 2) continue;
        const first = seg.points[0];
        ctx.moveTo(pixelX(vp, first.x), pixelY(vp, first.y));
        for (let i = 1; i < seg.points.length; i++) {
            const p = seg.points[i];
            ctx.lineTo(pixelX(vp, p.x), pixelY(vp, p.y));
        }
    }
    ctx.stroke();

    // Detected vertical asymptotes: dashed lines through the view.
    // Off by default (GeoGebra does not draw them); opt in per call
    // or per function via showAsymptotes.
    if (r.showAsymptotes === true && result.asymptotes.length > 0) {
        ctx.save();
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        for (const ax of result.asymptotes) {
            if (ax < visXMin || ax > visXMax) continue;
            const px = pixelX(vp, ax);
            ctx.beginPath();
            ctx.moveTo(px, 0);
            ctx.lineTo(px, vp.height);
            ctx.stroke();
        }
        ctx.restore();
    }

    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Draw label
    if (r.showLabel && segments.length > 0) {
        const lastSeg = segments[segments.length - 1];
        if (lastSeg.points.length > 0) {
            const p = lastSeg.points[lastSeg.points.length - 1];
            const px = pixelX(vp, p.x);
            const py = pixelY(vp, p.y);
            labelTasks.push({
                text: r.label,
                x: px + 6,
                y: py,
                opts: {
                    fontSize: 13,
                    color: r.color ?? DEFAULT_FUNC,
                    align: "start",
                    baseline: "middle"
                }
            });
        }
    }
}

function drawConic(
    ctx: CanvasRenderingContext2D,
    r: RenderableConic,
    vp: Viewport2D,
    visXMin: number,
    visXMax: number,
    visYMin: number,
    visYMax: number,
    labelTasks: LabelTask[]
): void {
    // Sample against the visible range so the curve stays accurate at any
    // zoom (same strategy as function curves)
    const result = sampleConic(
        { a: r.a, b: r.b, c: r.c, d: r.d, e: r.e, f: r.f },
        {
            xRange: [visXMin, visXMax],
            yRange: [visYMin, visYMax],
            pixelWidth: vp.width,
            pixelHeight: vp.height
        }
    );
    const segments = result;

    ctx.strokeStyle = r.color ?? DEFAULT_FUNC;
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 3);
    if (r.opacity !== undefined) {
        ctx.globalAlpha = r.opacity;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, vp.width, vp.height);
    ctx.clip();

    ctx.beginPath();
    for (const seg of segments) {
        if (seg.points.length < 2) continue;
        const first = seg.points[0];
        ctx.moveTo(pixelX(vp, first.x), pixelY(vp, first.y));
        for (let i = 1; i < seg.points.length; i++) {
            const p = seg.points[i];
            ctx.lineTo(pixelX(vp, p.x), pixelY(vp, p.y));
        }
    }
    ctx.stroke();

    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Draw label at the last point of the last segment
    if (r.showLabel && segments.length > 0) {
        const lastSeg = segments[segments.length - 1];
        if (lastSeg.points.length > 0) {
            const p = lastSeg.points[lastSeg.points.length - 1];
            labelTasks.push({
                text: r.label,
                x: pixelX(vp, p.x) + 6,
                y: pixelY(vp, p.y),
                opts: {
                    fontSize: 13,
                    color: r.color ?? DEFAULT_FUNC,
                    align: "start",
                    baseline: "middle"
                }
            });
        }
    }
}

/** Draw a point shape at pixel coords (no label). Shared by points and lists. */
function drawPointShape(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    size: number,
    style: number,
    color: string
): void {
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    switch (style) {
        case 0: // Dot
            ctx.beginPath();
            ctx.arc(px, py, size, 0, Math.PI * 2);
            ctx.fill();
            break;
        case 1: // Cross
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px - size, py - size);
            ctx.lineTo(px + size, py + size);
            ctx.moveTo(px + size, py - size);
            ctx.lineTo(px - size, py + size);
            ctx.stroke();
            break;
        case 2: // Empty circle
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(px, py, size, 0, Math.PI * 2);
            ctx.stroke();
            break;
        case 3: // Plus
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(px - size, py);
            ctx.lineTo(px + size, py);
            ctx.moveTo(px, py - size);
            ctx.lineTo(px, py + size);
            ctx.stroke();
            break;
        case 4: // Diamond
            ctx.beginPath();
            ctx.moveTo(px, py - size);
            ctx.lineTo(px + size, py);
            ctx.lineTo(px, py + size);
            ctx.lineTo(px - size, py);
            ctx.closePath();
            ctx.fill();
            break;
        default: // Default: dot
            ctx.beginPath();
            ctx.arc(px, py, size, 0, Math.PI * 2);
            ctx.fill();
            break;
    }
}

function drawPoint(
    ctx: CanvasRenderingContext2D,
    r: RenderablePoint,
    vp: Viewport2D,
    labelTasks: LabelTask[]
): void {
    const px = pixelX(vp, r.x);
    const py = pixelY(vp, r.y);
    const size = r.pointSize ?? 5;
    const style = r.pointStyle ?? 0;
    const color = r.color ?? "#1565C0";

    drawPointShape(ctx, px, py, size, style, color);

    // Draw label if visible
    if (r.showLabel && r.visible) {
        labelTasks.push({
            text: r.label,
            x: px + (size + 4),
            y: py - (size + 4),
            opts: {
                fontSize: 13,
                color,
                align: "start",
                baseline: "bottom"
            }
        });
    }
}

/** Draw a list of points (Sequence output). No per-point labels. */
function drawPointList(
    ctx: CanvasRenderingContext2D,
    r: RenderablePointList,
    vp: Viewport2D
): void {
    const size = r.pointSize ?? 5;
    const style = r.pointStyle ?? 0;
    const color = r.color ?? "#1565C0";
    for (const p of r.points) {
        drawPointShape(ctx, pixelX(vp, p.x), pixelY(vp, p.y), size, style, color);
    }
}

function drawLine(
    ctx: CanvasRenderingContext2D,
    r: RenderableLine,
    vp: Viewport2D,
    labelTasks: LabelTask[]
): void {
    // ax + by + c = 0 → compute two points on the line at the canvas edges
    const xMin = dataX(vp, 0);
    const xMax = dataX(vp, vp.width);

    let labelAnchor: { x: number; y: number } | undefined;

    ctx.strokeStyle = r.color ?? DEFAULT_AXIS;
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);

    ctx.beginPath();
    if (Math.abs(r.b) > 1e-10) {
        // y = -(ax + c) / b
        const y1 = -(r.a * xMin + r.c) / r.b;
        const y2 = -(r.a * xMax + r.c) / r.b;
        ctx.moveTo(pixelX(vp, xMin), pixelY(vp, y1));
        ctx.lineTo(pixelX(vp, xMax), pixelY(vp, y2));
        // Anchor the label on the line well inside the canvas (≈10% from the
        // left edge) so the caption draws to the LEFT of the anchor (right-
        // aligned) and stays inside the viewport. Clamp y to the visible range
        // so a steep line (whose endpoint flies off the top/bottom) still shows.
        const visYTop = dataY(vp, 0);
        const visYBottom = dataY(vp, vp.height);
        const anchorX = xMin + (xMax - xMin) * 0.1;
        const anchorY = -(r.a * anchorX + r.c) / r.b;
        labelAnchor = {
            x: anchorX,
            y: Math.min(Math.max(anchorY, visYBottom), visYTop)
        };
    } else {
        // Vertical line: x = -c/a
        const x = -r.c / r.a;
        ctx.moveTo(pixelX(vp, x), 0);
        ctx.lineTo(pixelX(vp, x), vp.height);
        // Anchor at a readable spot on the line: the upper portion of the
        // visible segment, not the math y=0 (which may be off-screen when
        // panned) and definitely not the canvas top edge.
        labelAnchor = { x, y: dataY(vp, vp.height * 0.18) };
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Label: value-mode lines carry a pre-rendered equation (labelText);
    // otherwise fall back to the name. Placed to the LEFT of the anchor
    // (right-aligned). The label's right edge is clamped so the whole caption
    // stays inside the canvas: estimate its pixel width (no reliable pre-
    // measure for async MathJax labels) and push the right edge inboard, then
    // re-derive the anchor y on the line at the clamped x so the caption still
    // sits on the line rather than floating beside it.
    if (r.showLabel && labelAnchor) {
        const labelText = r.labelText ?? r.label;
        const fontSize = 13;
        // ~0.6em per char is a safe upper bound for mixed digits/operators.
        const estWidth = labelText.length * fontSize * 0.6;
        const margin = 8;
        const rightEdge = pixelX(vp, labelAnchor.x) - 6;
        const clampedRight = Math.min(
            Math.max(rightEdge, estWidth + margin),
            vp.width - margin
        );
        // y on the line at the clamped x (math coord), clamped to the view.
        const visYTop = dataY(vp, 0);
        const visYBottom = dataY(vp, vp.height);
        const clampedMathX = dataX(vp, clampedRight + 6);
        let labelY = labelAnchor.y;
        if (Math.abs(r.b) > 1e-10) {
            const onLine = -(r.a * clampedMathX + r.c) / r.b;
            labelY = Math.min(Math.max(onLine, visYBottom), visYTop);
        }
        labelTasks.push({
            text: labelText,
            x: clampedRight,
            y: pixelY(vp, labelY),
            opts: {
                fontSize,
                color: r.color ?? DEFAULT_FUNC,
                align: "end",
                baseline: "middle"
            }
        });
    }
}

function drawSegment(
    ctx: CanvasRenderingContext2D,
    r: RenderableSegment,
    vp: Viewport2D
): void {
    ctx.strokeStyle = r.color ?? "#333333";
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);

    ctx.beginPath();
    ctx.moveTo(pixelX(vp, r.x1), pixelY(vp, r.y1));
    ctx.lineTo(pixelX(vp, r.x2), pixelY(vp, r.y2));
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawPolygon(
    ctx: CanvasRenderingContext2D,
    r: RenderablePolygon,
    vp: Viewport2D
): void {
    if (r.vertices.length < 2) return;

    ctx.strokeStyle = r.color ?? "#333333";
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);
    if (r.fillColor) {
        ctx.fillStyle = r.fillColor;
    }

    ctx.beginPath();
    const first = r.vertices[0];
    ctx.moveTo(pixelX(vp, first.x), pixelY(vp, first.y));
    for (let i = 1; i < r.vertices.length; i++) {
        const v = r.vertices[i];
        ctx.lineTo(pixelX(vp, v.x), pixelY(vp, v.y));
    }
    ctx.closePath();
    if (r.fillColor) ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawCircle(
    ctx: CanvasRenderingContext2D,
    r: RenderableCircle,
    vp: Viewport2D
): void {
    const px = pixelX(vp, r.centerX);
    const py = pixelY(vp, r.centerY);
    // Radius in pixels — use average scale for circles
    const radiusPx = r.radius * (vp.scaleX + vp.scaleY) / 2;

    ctx.strokeStyle = r.color ?? "#333333";
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);
    if (r.fillColor) {
        ctx.fillStyle = r.fillColor;
    }

    ctx.beginPath();
    ctx.arc(px, py, radiusPx, 0, Math.PI * 2);
    if (r.fillColor) ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawText(
    ctx: CanvasRenderingContext2D,
    r: RenderableText,
    vp: Viewport2D,
    labelTasks: LabelTask[]
): void {
    // Absolute-screen text: x/y are already pixel coords (do not pan/zoom).
    const px = r.absolute ? r.x : pixelX(vp, r.x);
    const py = r.absolute ? r.y : pixelY(vp, r.y);
    const fontSize = r.fontSize ?? 13;

    // LaTeX content is passed through wrapped in \( \) so a LaTeX-aware
    // label renderer (e.g. MathJax) picks it up verbatim; the playground's
    // renderer forwards strings starting with \( unchanged, and the plain
    // fallback strips the delimiters.
    const text = r.isLatex && !r.content.trimStart().startsWith("\\(")
        ? `\\(${r.content}\\)`
        : r.content;

    labelTasks.push({
        text,
        x: px,
        y: py,
        opts: {
            fontSize,
            color: r.color ?? "#333333",
            align: "start",
            baseline: "alphabetic",
            serif: r.serif
        }
    });
}

/**
 * Draw a slider (numeric drag control): a track line plus a knob whose
 * position reflects the current value. The track and knob are in math
 * coords so the slider pans/zooms with the rest of the construction. Line
 * thickness, dash style and opacity come from the element's `<lineStyle>`
 * (so e.g. the δ slider's thickness=10/opacity=100 are honoured).
 */
function drawSlider(
    ctx: CanvasRenderingContext2D,
    r: RenderableSlider,
    vp: Viewport2D,
    labelTasks: LabelTask[],
    decimals?: number
): void {
    const range = r.max - r.min;
    const t = range > 0 ? (r.value - r.min) / range : 0;
    // Track endpoints in math coords.
    const w = r.width;
    const start = { x: r.x, y: r.y };
    const end = r.horizontal
        ? { x: r.x + w, y: r.y }
        : { x: r.x, y: r.y - w }; // vertical: up = +y in math
    const knob = {
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t
    };

    const color = r.color ?? "#333333";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    // Honour the stored thickness/opacity (default 2px solid when absent).
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);
    if (r.opacity !== undefined) {
        ctx.globalAlpha = r.opacity;
    }

    // Track
    ctx.beginPath();
    ctx.moveTo(pixelX(vp, start.x), pixelY(vp, start.y));
    ctx.lineTo(pixelX(vp, end.x), pixelY(vp, end.y));
    ctx.stroke();

    // Knob
    const kx = pixelX(vp, knob.x);
    const ky = pixelY(vp, knob.y);
    ctx.beginPath();
    ctx.arc(kx, ky, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);

    // Label: name at the start, value near the knob.
    if (r.showLabel) {
        labelTasks.push({
            text: r.label,
            x: pixelX(vp, start.x),
            y: pixelY(vp, start.y) - 8,
            opts: {
                fontSize: r.fontSize ?? 13,
                color,
                align: "start",
                baseline: "bottom"
            }
        });
    }
    labelTasks.push({
        text: formatNumber(r.value, decimals),
        x: kx,
        y: ky - 8,
        opts: {
            fontSize: r.fontSize ?? 12,
            color,
            align: "middle",
            baseline: "bottom"
        }
    });
}
