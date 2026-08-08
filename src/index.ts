/**
 * geoview — A parser and renderer for .ggb files.
 *
 * Renders geometric constructions from .ggb files onto Canvas 2D,
 * independent of the GeoGebra application. Supports reading the .ggb
 * file format (a zip archive containing geogebra.xml) and rendering
 * its geometric objects (points, lines, circles, functions, etc.).
 */

export { VERSION } from "./version";
export { unzipGgb } from "./archive";
export { parseXml } from "./parser";
export { parseGgb } from "./api";
export type * from "./types";
export { GgbParseError } from "./types";
