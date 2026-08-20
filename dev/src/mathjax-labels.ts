/**
 * MathJax label renderer for geoview playground.
 *
 * Converts text labels to LaTeX, renders them via MathJax v3 into SVG,
 * converts SVG → Image for Canvas drawImage.
 *
 * - Axis labels "x"/"y" → italic math variable
 * - Numbers → plain text (no LaTeX needed)
 * - Function labels like "f(x) = sin(x)" → rendered as math
 * - Mixed text + math (e.g. "半径：\[r = \frac{...}\]=87.62") → split into text
 *   and math segments, render each math segment, composite onto a canvas so
 *   plain text and rendered formulae lay out on one line.
 *
 * MathJax is loaded lazily via a CDN script tag (only when the first
 * label needs rendering). Results are cached by text+style key.
 */
import type { LabelRenderResult } from "geoview";

// Cache: text+opts → Image/Canvas, so we don't re-render the same label every frame
const cache = new Map<string, HTMLImageElement | HTMLCanvasElement>();

// MathJax load promise
let mjPromise: Promise<void> | null = null;

// Reusable offscreen canvas for measuring text widths.
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
    if (!measureCtx) {
        const c = document.createElement("canvas");
        measureCtx = c.getContext("2d")!;
    }
    return measureCtx;
}

/**
 * Load MathJax v3 from CDN via dynamic <script> tag.
 * Configures it for SVG output and lazy startup.
 */
function ensureMathJax(): Promise<void> {
    // MathJax is only "ready" once its startup promise resolves. The config
    // object we install below is truthy, but startup may not have run yet, so
    // we must not treat its mere presence as readiness — otherwise the first
    // render calls tex2svgPromise before MathJax is initialised, falls back to
    // plain text (drawn at the alphabetic baseline), and then a later render
    // draws the typeset image (drawn from the top) — making the label visibly
    // jump down on the first interaction.
    if (mjPromise) return mjPromise;
    const existing = (window as any).MathJax?.startup?.promise as Promise<void> | undefined;
    if (existing) {
        mjPromise = existing;
        return existing;
    }

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

type Segment =
    | { type: "text"; content: string }
    | { type: "math"; display: boolean; content: string };

/**
 * Split a string into alternating text and math segments on \[...\]
 * (display) and \(...\) (inline) delimiters. A string with no delimiters
 * yields a single text segment.
 */
function splitMathSegments(text: string): Segment[] {
    const segments: Segment[] = [];
    const re = /\\\[(.*?)\\\]|\\\((.*?)\\\)/gs;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        if (m.index > last) segments.push({ type: "text", content: text.slice(last, m.index) });
        if (m[1] !== undefined) segments.push({ type: "math", display: true, content: m[1] });
        else segments.push({ type: "math", display: false, content: m[2] });
        last = re.lastIndex;
    }
    if (last < text.length) segments.push({ type: "text", content: text.slice(last) });
    return segments.filter((s) => s.type === "math" || s.content.length > 0);
}

/**
 * Render a single TeX string to an SVG Image via MathJax. The colour is
 * baked into the SVG (MathJax emits fill="currentColor" which is black in a
 * standalone image). Renders at `scale`× the font size so the resulting
 * image has device-resolution pixels (crisp on high-DPR canvases). Returns
 * null when rendering fails.
 */
async function renderMath(
    tex: string,
    display: boolean,
    fontSize: number,
    color: string,
    scale: number
): Promise<HTMLImageElement | null> {
    try {
        await ensureMathJax();
        const mj = (window as any).MathJax;
        const svgWrapper = await mj.tex2svgPromise(tex, {
            display,
            em: fontSize * scale,
            ex: (fontSize * scale) / 2
        });
        const svgEl = svgWrapper.querySelector("svg");
        if (!svgEl) return null;

        const svgStr = new XMLSerializer()
            .serializeToString(svgEl)
            .replace(/currentColor/g, color);
        const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgStr);

        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("Image load failed"));
            img.src = dataUrl;
        });
        return img;
    } catch {
        return null;
    }
}

/**
 * Composite alternating text and math-image segments onto a single canvas so
 * a mixed label like "半径：[formula]=87.62" renders as plain text with the
 * formula typeset inline. Text is drawn at `fontSize`; each math image is
 * scaled so its height matches the surrounding text (display math slightly
 * taller). Returns null on failure so the caller can fall back to plain text.
 */
async function compositeMixed(
    segments: Segment[],
    fontSize: number,
    color: string,
    serif: boolean,
    scale: number
): Promise<HTMLCanvasElement | null> {
    const fontFamily = serif ? "serif" : "sans-serif";

    // Render math segments to images first (at device resolution).
    type Laid =
        | { type: "text"; content: string; width: number; height: number }
        | { type: "image"; img: HTMLImageElement; width: number; height: number };
    const laid: Laid[] = [];

    const mctx = getMeasureCtx();
    mctx.font = `${fontSize}px ${fontFamily}`;

    let totalWidth = 0;
    let maxHeight = fontSize;

    for (const seg of segments) {
        if (seg.type === "text") {
            const width = mctx.measureText(seg.content).width;
            laid.push({ type: "text", content: seg.content, width, height: fontSize });
            totalWidth += width;
        } else {
            const img = await renderMath(seg.content, seg.display, fontSize, color, scale);
            if (!img || !img.width || !img.height) {
                // Fall back to drawing the raw TeX as text.
                const content = seg.content;
                const width = mctx.measureText(content).width;
                laid.push({ type: "text", content, width, height: fontSize });
                totalWidth += width;
            } else {
                // img.height is in device pixels (rendered at `scale`×); the
                // desired CSS height drives the on-screen size.
                const targetH = seg.display ? fontSize * 1.5 : fontSize * 1.1;
                const imgScale = targetH * scale / img.height;
                const width = img.width * imgScale;
                laid.push({ type: "image", img, width, height: targetH });
                totalWidth += width;
            }
        }
        if (laid[laid.length - 1].height > maxHeight) {
            maxHeight = laid[laid.length - 1].height;
        }
    }

    if (totalWidth <= 0) return null;
    // Allocate the composite canvas at device resolution and scale its context
    // so we can keep laying out in CSS coordinates while every pixel maps 1:1
    // to the backing store (crisp text + crisp math images, no blur on DPR).
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(totalWidth * scale);
    canvas.height = Math.ceil(maxHeight * scale);
    const cctx = canvas.getContext("2d");
    if (!cctx) return null;
    cctx.setTransform(scale, 0, 0, scale, 0, 0);
    cctx.font = `${fontSize}px ${fontFamily}`;
    cctx.fillStyle = color;
    cctx.textBaseline = "alphabetic";
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = "high";

    let x = 0;
    // Text baseline sits near the bottom of the line; place it so the text
    // baseline is at maxHeight - a small descent pad.
    const baseline = maxHeight - (maxHeight - fontSize) / 2 - fontSize * 0.2;
    for (const seg of laid) {
        if (seg.type === "text") {
            cctx.fillText(seg.content, x, baseline);
        } else {
            // Draw the device-resolution math image at its CSS size; under the
            // scale transform this maps image pixels 1:1 to backing pixels.
            cctx.drawImage(seg.img, x, maxHeight - seg.height, seg.width, seg.height);
        }
        x += seg.width;
    }
    return canvas;
}

export function createMathJaxLabelRenderer() {
    return async function mathJaxLabelRenderer(
        text: string,
        opts?: { fontSize?: number; color?: string; italic?: boolean; serif?: boolean }
    ): Promise<LabelRenderResult> {
        const fontSize = opts?.fontSize ?? 13;
        const color = opts?.color ?? "#1c1c1f";
        const serif = opts?.serif ?? false;
        // Render at device resolution so formulae stay crisp on high-DPR
        // canvases (the renderer draws the returned image at its CSS size).
        const scale = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
        const cacheKey = `${text}|${fontSize}|${color}|${serif}|${scale}`;
        const cached = cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        // Mixed text + math (contains \[...\] or \(...\) delimiters).
        if (/\\[\[\]()]/.test(text)) {
            const segments = splitMathSegments(text);
            if (segments.length > 1 || (segments.length === 1 && segments[0].type === "math")) {
                const canvas = await compositeMixed(segments, fontSize, color, serif, scale);
                if (canvas) {
                    cache.set(cacheKey, canvas);
                    return canvas;
                }
            }
            // Single text segment that merely contained a stray backslash —
            // fall through to the plain path below.
        }

        const latex = toLatex(text, opts);

        // If no LaTeX needed, return plain string (fast path)
        if (!latex.startsWith("\\(")) {
            return text;
        }

        // Check cache (second key form for the wrapped variant)
        const wrappedKey = `${latex}|${fontSize}|${color}|${scale}`;
        const wrappedCached = cache.get(wrappedKey);
        if (wrappedCached) {
            return wrappedCached;
        }

        try {
            // Strip LaTeX delimiters — the raw TeX is what gets rendered.
            let tex = latex;
            if (tex.startsWith("\\(") && tex.endsWith("\\)")) {
                tex = tex.slice(2, -2);
            } else if (tex.startsWith("\\[") && tex.endsWith("\\]")) {
                tex = tex.slice(2, -2);
            }

            const img = await renderMath(tex, false, fontSize, color, scale);
            if (!img) return text;

            cache.set(wrappedKey, img);
            return img;
        } catch {
            // Fall back to plain text
            return text;
        }
    };
}
