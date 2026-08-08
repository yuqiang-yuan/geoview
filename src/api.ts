/**
 * geoview — High-level API combining archive extraction, XML parsing,
 * scene building, and rendering.
 */

import { unzipGgb } from "./archive";
import { parseXml } from "./parser";
import { buildScene } from "./scene-builder";
import { createRenderer2D } from "./renderer-2d";
import type { GgbArchive, GgbDocument } from "./types";
import type { Renderer, RenderGgbOptions, Scene, RenderMode } from "./render-types";

/**
 * Parse a .ggb file from raw bytes into a typed document.
 *
 * This is the main entry point: it unzips the .ggb archive and parses
 * the geogebra.xml into a structured {@link GgbDocument}.
 *
 * @param data — raw bytes of the .ggb file
 * @returns typed document representation
 * @throws {GgbParseError} if extraction or parsing fails
 */
export function parseGgb(data: ArrayBuffer | Uint8Array): GgbDocument {
    const archive: GgbArchive = unzipGgb(data);
    return parseXml(archive.xml);
}

/**
 * Render a parsed GgbDocument to a canvas.
 *
 * Auto-detects 2D mode (3D will be supported in a later phase),
 * builds a Scene, and renders it using the Canvas 2D backend.
 *
 * @param doc     parsed GgbDocument
 * @param canvas  target canvas element
 * @param options optional configuration
 * @returns the renderer instance (for further control)
 */
export function renderGgb(
    doc: GgbDocument,
    canvas: HTMLCanvasElement,
    options: RenderGgbOptions = {}
): Renderer {
    const mode: RenderMode = options.mode ?? "2d";
    const width = options.width ?? canvas.clientWidth ?? 800;
    const height = options.height ?? canvas.clientHeight ?? 600;

    // Build scene
    const scene: Scene = buildScene(doc, {
        mode,
        width,
        height,
        nSamples: options.nSamples
    });

    if (mode === "2d") {
        const renderer = createRenderer2D(
            canvas,
            width,
            height,
            options.dpr ?? (typeof window !== "undefined"
                ? window.devicePixelRatio || 1
                : 1)
        );
        renderer.render(scene);
        return renderer;
    }

    // 3D mode will be implemented in a later phase
    throw new Error("3D rendering not yet implemented");
}
