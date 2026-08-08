/**
 * MathJax label renderer for geoview playground.
 *
 * Converts text labels to LaTeX, renders them via MathJax v3 into SVG,
 * converts SVG → Image for Canvas drawImage.
 *
 * - Axis labels "x"/"y" → italic math variable
 * - Numbers → plain text (no LaTeX needed)
 * - Function labels like "f(x) = sin(x)" → rendered as math
 * - Other text → plain text fallback
 *
 * MathJax is loaded lazily via a CDN script tag (only when the first
 * label needs rendering). Results are cached by text+style key.
 */
import type { LabelRenderResult } from "geoview";

// Cache: text+opts → Image, so we don't re-render the same label every frame
const cache = new Map<string, HTMLImageElement>();

// MathJax load promise
let mjPromise: Promise<void> | null = null;

/**
 * Load MathJax v3 from CDN via dynamic <script> tag.
 * Configures it for SVG output and lazy startup.
 */
function ensureMathJax(): Promise<void> {
    if ((window as any).MathJax) return Promise.resolve();
    if (mjPromise) return mjPromise;

    mjPromise = new Promise<void>((resolve, reject) => {
        // Configure MathJax before loading
        (window as any).MathJax = {
            tex: {
                inlineMath: [["\\(", "\\)"]],
                displayMath: [["\\[", "\\]"]]
            },
            svg: { fontCache: "local" },
            startup: {
                ready: () => {
                    // Call default ready function
                    (window as any).MathJax.startup.defaultReady();
                    (window as any).MathJax.startup.promise.then(() => resolve());
                }
            }
        };

        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
        script.async = true;
        script.onload = () => {
            // MathJax startup will call resolve via the ready callback
        };
        script.onerror = () => reject(new Error("Failed to load MathJax"));
        document.head.appendChild(script);
    });

    return mjPromise;
}

/**
 * Convert a label string to LaTeX.
 * - Numbers (tick labels) → return as-is (no LaTeX)
 * - Italic single char (axis labels) → inline math
 * - Function labels like "f(x) = sin(x)" → inline math with LaTeX macros
 */
function toLatex(text: string, opts?: { italic?: boolean }): string {
    // Already has LaTeX delimiters → pass through as-is
    if (/^\\[(\(]/.test(text.trim())) {
        return text;
    }
    // Numbers (tick labels) — no LaTeX
    if (/^-?\d+(\.\d+)?$/.test(text.trim())) {
        return text;
    }
    // Italic single char (axis labels like x, y)
    if (opts?.italic && text.length === 1) {
        return `\\(${text}\\)`;
    }
    // Function labels or expressions — wrap in inline math
    if (/[()=]/.test(text)) {
        let latex = text
            .replace(/\bsin\b/g, "\\sin")
            .replace(/\bcos\b/g, "\\cos")
            .replace(/\btan\b/g, "\\tan")
            .replace(/\bsqrt\b/g, "\\sqrt")
            .replace(/\bpi\b/g, "\\pi")
            .replace(/\binf\b/g, "\\infty")
            .replace(/\^(\S+)/g, "^{$1}");
        return `\\(${latex}\\)`;
    }
    // Default — italic for single-char math variables
    return `\\(${text}\\)`;
}

export function createMathJaxLabelRenderer() {
    return async function mathJaxLabelRenderer(
        text: string,
        opts?: { fontSize?: number; color?: string; italic?: boolean }
    ): Promise<LabelRenderResult> {
        const latex = toLatex(text, opts);

        // If no LaTeX needed, return plain string (fast path)
        if (!latex.startsWith("\\(")) {
            return text;
        }

        // Check cache
        const fontSize = opts?.fontSize ?? 13;
        const color = opts?.color ?? "#1c1c1f";
        const cacheKey = `${latex}|${fontSize}|${color}`;
        const cached = cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            await ensureMathJax();
            const mj = (window as any).MathJax;

            // Strip LaTeX delimiters — tex2svgPromise expects raw TeX
            let tex = latex;
            if (tex.startsWith("\\(") && tex.endsWith("\\)")) {
                tex = tex.slice(2, -2);
            } else if (tex.startsWith("\\[") && tex.endsWith("\\]")) {
                tex = tex.slice(2, -2);
            }

            // Render LaTeX to SVG
            const svgWrapper = await mj.tex2svgPromise(tex, {
                display: false,
                em: fontSize / 12,
                ex: fontSize / 6,
                color
            });

            // Get the <svg> element
            const svgEl = svgWrapper.querySelector("svg");
            if (!svgEl) return text;

            // Serialize SVG to data URL
            const svgStr = new XMLSerializer().serializeToString(svgEl);
            const dataUrl = "data:image/svg+xml;charset=utf-8," +
                encodeURIComponent(svgStr);

            // Create Image (wait for it to load)
            const img = new Image();
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error("Image load failed"));
                img.src = dataUrl;
            });

            cache.set(cacheKey, img);
            return img;
        } catch {
            // Fall back to plain text
            return text;
        }
    };
}
