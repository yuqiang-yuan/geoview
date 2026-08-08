/**
 * geoview — A parser and renderer for .ggb files.
 *
 * Renders geometric constructions from .ggb files onto Canvas 2D,
 * independent of the GeoGebra application. Supports reading the .ggb
 * file format (a zip archive containing geogebra.xml) and rendering
 * its geometric objects (points, lines, circles, functions, etc.).
 */

// Parsing
export { VERSION } from "./version";
export { unzipGgb } from "./archive";
export { parseXml } from "./parser";
export { parseGgb } from "./api";

// Rendering — types
export type * from "./render-types";
export { ggbColorToCss, ggbColorToThree } from "./render-types";

// Rendering — viewport, sampler, scene builder
export { buildViewport, extractDataRange, fitViewport } from "./viewport";
export { compileExpression, sampleFunction, builtinSampler } from "./sampler";
export { buildScene } from "./scene-builder";

// Rendering — 2D renderer
export { createRenderer2D } from "./renderer-2d";

// High-level convenience: parse + render in one call
export { renderGgb } from "./api";

// Parsing types
export type * from "./types";
export { GgbParseError } from "./types";
