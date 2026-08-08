/**
 * geoview — Archive layer.
 *
 * Extracts files from a .ggb ZIP archive using fflate.
 * The primary output is `geogebra.xml` (the construction description),
 * with optional thumbnail and embedded JavaScript.
 */

import { unzipSync, strFromU8 } from "fflate";
import type { GgbArchive } from "./types";
import { GgbParseError } from "./types";

/**
 * Extract a .ggb ZIP archive into a GgbArchive.
 *
 * @param data — raw bytes of the .ggb file
 * @returns parsed archive with decoded XML string
 * @throws {GgbParseError} if the archive is invalid or missing geogebra.xml
 */
export function unzipGgb(data: ArrayBuffer | Uint8Array): GgbArchive {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(bytes);
    } catch (e) {
        throw new GgbParseError("Failed to unzip .ggb archive", e);
    }

    if (Object.keys(files).length === 0) {
        throw new GgbParseError("Archive is empty");
    }

    const xmlBytes = files["geogebra.xml"];
    if (!xmlBytes) {
        throw new GgbParseError("Archive is missing geogebra.xml");
    }

    const xml = strFromU8(xmlBytes);

    // Optional files
    const thumbnail = files["geogebra_thumbnail.png"];
    const jsBytes = files["geogebra_javascript.js"];
    const javascript = jsBytes ? strFromU8(jsBytes) : undefined;

    return {
        xml,
        thumbnail: thumbnail || undefined,
        javascript,
        files
    };
}
