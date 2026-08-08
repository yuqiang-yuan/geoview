// Test setup — inject DOMParser polyfill for Node.js environment
import { DOMParser } from "@xmldom/xmldom";

if (typeof globalThis.DOMParser === "undefined") {
    (globalThis as Record<string, unknown>).DOMParser = DOMParser;
}
