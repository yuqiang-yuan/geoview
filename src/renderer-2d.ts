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
 */

import type {
    Renderable,
    RenderableFunction,
    RenderablePoint,
    RenderableLine,
    RenderableSegment,
    RenderablePolygon,
    RenderableCircle,
    RenderableText,
    Renderer2D,
    Scene,
    SceneAxis,
    Viewport2D
} from "./render-types";
import { builtinSampler } from "./sampler";

// Default colors
const DEFAULT_BG = "#ffffff";
const DEFAULT_AXIS = "#1c1c1f";
const DEFAULT_GRID = "#b4b3ba";
const DEFAULT_FUNC = "#006758";

const DEFAULT_SAMPLES = 800;

/**
 * Create a Canvas 2D renderer.
 */
export function createRenderer2D(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    dpr: number = typeof window !== "undefined"
        ? window.devicePixelRatio || 1
        : 1
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
     */
    function doRender(scene: Scene, vp: Viewport2D): void {
        const w = vp.width;
        const h = vp.height;

        // Clear
        ctx.clearRect(0, 0, w, h);
        // Background
        ctx.fillStyle = scene.bgColor ?? DEFAULT_BG;
        ctx.fillRect(0, 0, w, h);

        // Grid
        if (scene.showGrid) {
            drawGrid(ctx, vp, scene.gridColor ?? DEFAULT_GRID);
        }

        // Axes
        if (scene.showAxes) {
            drawAxes(ctx, vp, scene);
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
                drawFunction(ctx, r, vp, visXMin, visXMax, visYMin, visYMax);
            } else {
                drawRenderable(ctx, r, vp);
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
    scene: Scene
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

        drawXTicks(ctx, vp, scene, y0, xAxis);

        // Axis label (e.g. "x")
        if (xAxis?.label) {
            ctx.font = "italic 14px sans-serif";
            ctx.textAlign = "right";
            ctx.textBaseline = "bottom";
            ctx.fillText(xAxis.label, vp.width - 8, y0 - 6);
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

        drawYTicks(ctx, vp, scene, x0, yAxis);

        // Axis label (e.g. "y")
        if (yAxis?.label) {
            ctx.font = "italic 14px sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            ctx.fillText(yAxis.label, x0 + 6, 8);
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
    axis?: SceneAxis
): void {
    // Use tickDistance as the base step, but ensure a minimum pixel
    // spacing (~40px) by multiplying up when zoomed out.
    const baseStep = axis?.tickDistance ?? niceStep(50 / vp.scaleX);
    const step = ensureMinSpacing(baseStep, vp.scaleX, 40);

    const xMin = dataX(vp, 0);
    const xMax = dataX(vp, vp.width);
    const showNumbers = axis?.showNumbers ?? true;
    const fontSize = 12;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

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
            ctx.fillText(formatNumber(x), px, y0 + 5);
        }
    }
}

function drawYTicks(
    ctx: CanvasRenderingContext2D,
    vp: Viewport2D,
    scene: Scene,
    x0: number,
    axis?: SceneAxis
): void {
    // Use tickDistance as the base step, but ensure a minimum pixel
    // spacing (~40px) by multiplying up when zoomed out.
    const baseStep = axis?.tickDistance ?? niceStep(50 / vp.scaleY);
    const step = ensureMinSpacing(baseStep, vp.scaleY, 40);

    const yMin = dataY(vp, vp.height);
    const yMax = dataY(vp, 0);
    const showNumbers = axis?.showNumbers ?? true;
    const fontSize = 12;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

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
            ctx.fillText(formatNumber(y), x0 - 5, py);
        }
    }
}

function formatNumber(n: number): string {
    if (Math.abs(n) < 1e-10) return "0";
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
    vp: Viewport2D
): void {
    switch (r.kind) {
        case "function":
            // Should not reach here — functions are drawn via drawFunction
            break;
        case "point":
            drawPoint(ctx, r, vp);
            break;
        case "line":
            drawLine(ctx, r, vp);
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
            drawText(ctx, r, vp);
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
    if (style === 1) {
        // Dashed
        ctx.setLineDash([8, 4]);
    } else if (style === 2) {
        // Dotted
        ctx.setLineDash([2, 4]);
    } else if (style === 3) {
        // Dash-dot
        ctx.setLineDash([8, 4, 2, 4]);
    } else {
        ctx.setLineDash([]);
    }
}

function drawFunction(
    ctx: CanvasRenderingContext2D,
    r: RenderableFunction,
    vp: Viewport2D,
    visXMin: number,
    visXMax: number,
    visYMin: number,
    visYMax: number
): void {
    // Use the visible data range for sampling, so curves are accurate
    // at any zoom level. Fall back to the renderable's stored range.
    const xRange: [number, number] = [
        Math.min(r.xRange[0], visXMin),
        Math.max(r.xRange[1], visXMax)
    ];
    const yRange: [number, number] = [visYMin, visYMax];

    const segments = builtinSampler(r.expression, {
        xRange,
        yRange,
        angleUnit: r.angleUnit,
        nSamples: DEFAULT_SAMPLES,
        pixelWidth: vp.width
    });

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
            ctx.font = "13px sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(r.label, px + 6, py);
        }
    }
}

function drawPoint(
    ctx: CanvasRenderingContext2D,
    r: RenderablePoint,
    vp: Viewport2D
): void {
    const px = pixelX(vp, r.x);
    const py = pixelY(vp, r.y);
    const size = r.pointSize ?? 4;

    ctx.fillStyle = r.color ?? "#333333";
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
}

function drawLine(
    ctx: CanvasRenderingContext2D,
    r: RenderableLine,
    vp: Viewport2D
): void {
    // ax + by + c = 0 → compute two points on the line at the canvas edges
    const xMin = dataX(vp, 0);
    const xMax = dataX(vp, vp.width);

    ctx.strokeStyle = r.color ?? DEFAULT_AXIS;
    setLineStyle(ctx, r.lineStyle, r.strokeWidth ?? 2);

    ctx.beginPath();
    if (Math.abs(r.b) > 1e-10) {
        // y = -(ax + c) / b
        const y1 = -(r.a * xMin + r.c) / r.b;
        const y2 = -(r.a * xMax + r.c) / r.b;
        ctx.moveTo(pixelX(vp, xMin), pixelY(vp, y1));
        ctx.lineTo(pixelX(vp, xMax), pixelY(vp, y2));
    } else {
        // Vertical line: x = -c/a
        const x = -r.c / r.a;
        ctx.moveTo(pixelX(vp, x), 0);
        ctx.lineTo(pixelX(vp, x), vp.height);
    }
    ctx.stroke();
    ctx.setLineDash([]);
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
    vp: Viewport2D
): void {
    const px = pixelX(vp, r.x);
    const py = pixelY(vp, r.y);
    const fontSize = r.fontSize ?? 13;

    ctx.font = `${fontSize}px sans-serif`;
    ctx.fillStyle = r.color ?? "#333333";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(r.content, px, py);
}
