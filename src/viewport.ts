/**
 * geoview — Viewport computation.
 *
 * Converts GeoGebra's pixel-based coordinate system (xZero, yZero, scale,
 * yscale) into a data coordinate range [xMin, xMax] × [yMin, yMax],
 * then re-fits that range to a target canvas of arbitrary size while
 * preserving the original axis ratio.
 */

import type { GgbCoordSystem, GgbEuclidianView } from "./types";
import type { Viewport2D } from "./render-types";

/**
 * Extract the data coordinate range from a GGB euclidian view.
 *
 * GGB stores pixel positions: xZero = pixel x of data origin (x=0),
 * yZero = pixel y of data origin (y=0), scale = pixels per x-unit,
 * yscale = pixels per y-unit. Canvas y is downward.
 *
 * If the view also has explicit xMin/xMax/yMin/yMax, those are used directly.
 */
export function extractDataRange(
    view?: GgbEuclidianView
): { xMin: number; xMax: number; yMin: number; yMax: number } | undefined {
    if (!view?.coordSystem) return undefined;
    const cs = view.coordSystem;

    // Prefer explicit bounds if present
    if (cs.xMin !== undefined && cs.xMax !== undefined &&
        cs.yMin !== undefined && cs.yMax !== undefined) {
        return { xMin: cs.xMin, xMax: cs.xMax, yMin: cs.yMin, yMax: cs.yMax };
    }

    // Derive from pixel-based parameters
    const width = view.size?.width ?? 800;
    const height = view.size?.height ?? 600;
    const xZero = cs.xZero ?? width / 2;
    const yZero = cs.yZero ?? height / 2;
    const scale = cs.scale ?? 50;
    const yscale = cs.yscale ?? scale;

    return {
        xMin: -xZero / scale,
        xMax: (width - xZero) / scale,
        yMax: yZero / yscale,
        yMin: -(height - yZero) / yscale
    };
}

/**
 * Fit a data range into a target canvas, preserving the original
 * x:y scale ratio from the GGB document.
 *
 * @param range  data range extracted from the GGB document
 * @param targetWidth   target canvas CSS width
 * @param targetHeight  target canvas CSS height
 * @param coordSystem   original GGB coordSystem (to read scale ratio)
 * @returns a Viewport2D ready for rendering
 */
export function fitViewport(
    range: { xMin: number; xMax: number; yMin: number; yMax: number },
    targetWidth: number,
    targetHeight: number,
    coordSystem?: GgbCoordSystem
): Viewport2D {
    const dataWidth = range.xMax - range.xMin;
    const dataHeight = range.yMax - range.yMin;

    // Determine the original axis ratio (yscale/scale)
    // e.g. 2:1 means y-axis is twice as "zoomed" as x-axis
    const origScale = coordSystem?.scale ?? 50;
    const origYscale = coordSystem?.yscale ?? origScale;
    const axisRatio = origYscale / origScale; // e.g. 2.0 for 2:1

    // We need scaleX and scaleY such that:
    //   1. The entire data range fits in the canvas
    //   2. scaleY = axisRatio * scaleX (preserve axis ratio)
    //   3. The content is centered

    // Try fitting by width first
    let scaleX = targetWidth / dataWidth;
    let scaleY = axisRatio * scaleX;

    // Check if height fits; if not, fit by height instead
    if (dataHeight * scaleY > targetHeight) {
        scaleY = targetHeight / dataHeight;
        scaleX = scaleY / axisRatio;
    }

    // Center: compute xZero and yZero so the data range is centered
    const xZero = (targetWidth - (range.xMin + range.xMax) * scaleX) / 2;
    const yZero = (targetHeight - (range.yMin + range.yMax) * scaleY) / 2;
    // Note: yMin is negative (bottom), yMax is positive (top)
    // Canvas y is downward, so yZero = pixel y of data y=0

    return {
        mode: "2d",
        xZero,
        yZero,
        scaleX,
        scaleY,
        width: targetWidth,
        height: targetHeight
    };
}

/**
 * Convenience: extract range from GGB view and fit to target canvas.
 */
export function buildViewport(
    view: GgbEuclidianView | undefined,
    targetWidth: number,
    targetHeight: number
): Viewport2D {
    const range = extractDataRange(view);
    if (!range) {
        // Default fallback: [-10, 10] × [-7, 7]
        return fitViewport(
            { xMin: -10, xMax: 10, yMin: -7, yMax: 7 },
            targetWidth,
            targetHeight,
            view?.coordSystem
        );
    }
    return fitViewport(range, targetWidth, targetHeight, view?.coordSystem);
}
