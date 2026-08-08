/**
 * geoview — High-level API combining archive extraction and XML parsing.
 */

import { unzipGgb } from "./archive";
import { parseXml } from "./parser";
import type { GgbArchive, GgbDocument } from "./types";

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
