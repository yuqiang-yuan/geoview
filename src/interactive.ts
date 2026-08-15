/**
 * geoview — Interactive controller.
 *
 * Wires pointer events to the reactive kernel so free objects (sliders and
 * free points) can be dragged. The controller owns no DOM listeners itself;
 * the host (e.g. the dev playground) calls {@link hitTest} on pointer-down
 * to decide between an object drag and a pan, then drives
 * {@link beginDrag}/{@link dragTo}/{@link endDrag} from its own handlers.
 *
 * On each drag it mutates a kernel free value, rebuilds the scene, and
 * re-renders via {@link Renderer2D.updateScene} (which preserves the current
 * pan/zoom, unlike the initial {@link Renderer2D.render}).
 */

import type { GgbDocument, GgbConstructionItem } from "./types";
import type { SceneBuildOptions, Renderer2D } from "./render-types";
import { buildScene } from "./scene-builder";
import { Kernel } from "./kernel";

/** Immutable slider geometry, precomputed once from the document. */
interface SliderGeom {
    label: string;
    x: number;
    y: number;
    width: number;
    horizontal: boolean;
    min: number;
    max: number;
    step?: number;
}

/** Options for {@link createInteractive} (mirror the scene build options). */
export interface InteractiveOptions extends SceneBuildOptions {
    // width/height/mode/nSamples/showAsymptotes inherited from SceneBuildOptions
}

/** A draggable object hit by the pointer. */
export interface HitTarget {
    kind: "slider" | "point";
    label: string;
}

/** Pointer-to-object interaction driver. */
export interface Interactive {
    readonly kernel: Kernel;
    /** What (if anything) is under the pointer, for the down decision. */
    hitTest(clientX: number, clientY: number): HitTarget | null;
    /** Begin dragging a hit target (suppresses panning). */
    beginDrag(target: HitTarget, clientX: number, clientY: number): void;
    /** Continue the active drag to a new pointer position. */
    dragTo(clientX: number, clientY: number): void;
    /** End the active drag. */
    endDrag(): void;
    /** Is a drag in progress? */
    isDragging(): boolean;
}

const HIT_RADIUS_PX = 9;

/**
 * Create an interactive controller over a parsed document and renderer.
 * Establishes the kernel-driven scene as the renderer's current scene.
 */
export function createInteractive(
    doc: GgbDocument,
    renderer: Renderer2D,
    canvas: HTMLCanvasElement,
    options: InteractiveOptions = {}
): Interactive {
    const kernel = new Kernel(doc);
    const buildOpts: SceneBuildOptions = {
        mode: options.mode,
        width: options.width ?? canvas.clientWidth ?? 800,
        height: options.height ?? canvas.clientHeight ?? 600,
        nSamples: options.nSamples,
        showAsymptotes: options.showAsymptotes,
        kernel
    };

    function rebuild(): void {
        const scene = buildScene(doc, buildOpts);
        renderer.updateScene(scene);
    }

    // Establish the kernel-driven scene as current.
    renderer.render(buildScene(doc, buildOpts));

    // Slider geometry never changes across drags, so precompute it once
    // from the document. (Knob *position* still comes from the kernel's
    // live value; only the track anchor/length/min/max are static.) This
    // keeps hit-testing off the scene-build hot path.
    const sliders = collectSliderGeometry(doc.construction.items);

    // Active drag state.
    let active: HitTarget | null = null;

    /** Convert client coords → canvas-local CSS pixels. */
    function toCanvas(clientX: number, clientY: number): { x: number; y: number } {
        const rect = canvas.getBoundingClientRect();
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    /** Canvas CSS pixels → math coords, using the renderer's viewport. */
    function toMath(px: number, py: number): { x: number; y: number } {
        const vp = renderer.getViewport();
        return {
            x: (px - vp.xZero) / vp.scaleX,
            y: (vp.yZero - py) / vp.scaleY
        };
    }

    function hitTest(clientX: number, clientY: number): HitTarget | null {
        const { x: cx, y: cy } = toCanvas(clientX, clientY);
        const vp = renderer.getViewport();

        let best: { target: HitTarget; dist: number } | null = null;

        // Slider knobs: position along the track at the current value.
        for (const sl of sliders) {
            const val = kernel.getValue(sl.label);
            const value = val?.kind === "number" ? val.value : sl.min;
            const knob = sliderKnobGeom(sl, value);
            const kx = vp.xZero + knob.x * vp.scaleX;
            const ky = vp.yZero - knob.y * vp.scaleY;
            const d = Math.hypot(kx - cx, ky - cy);
            if (d <= HIT_RADIUS_PX && (!best || d < best.dist)) {
                best = { target: { kind: "slider", label: sl.label }, dist: d };
            }
        }

        // Free points: draggable point values from the kernel.
        for (const obj of kernel.freeObjects()) {
            if (obj.kind !== "point") continue;
            const v = kernel.getValue(obj.label);
            if (v?.kind !== "point") continue;
            const kx = vp.xZero + v.x * vp.scaleX;
            const ky = vp.yZero - v.y * vp.scaleY;
            const d = Math.hypot(kx - cx, ky - cy);
            if (d <= HIT_RADIUS_PX && (!best || d < best.dist)) {
                best = { target: { kind: "point", label: obj.label }, dist: d };
            }
        }
        return best?.target ?? null;
    }

    function beginDrag(target: HitTarget): void {
        active = target;
    }

    function dragTo(clientX: number, clientY: number): void {
        if (!active) return;
        const { x: cx, y: cy } = toCanvas(clientX, clientY);
        const math = toMath(cx, cy);

        if (active.kind === "slider") {
            const sl = sliders.find((s) => s.label === active!.label);
            if (!sl) return;
            // Project pointer onto the slider axis → normalized t → value.
            const along = sl.horizontal
                ? (math.x - sl.x) / sl.width
                : (sl.y - math.y) / sl.width;
            const t = Math.max(0, Math.min(1, along));
            let value = sl.min + t * (sl.max - sl.min);
            if (sl.step && sl.step > 0) {
                value = Math.round(value / sl.step) * sl.step;
            }
            value = Math.max(sl.min, Math.min(sl.max, value));
            kernel.setValue(active.label, { kind: "number", value });
        } else {
            // Free point: set to pointer math coords.
            kernel.setValue(active.label, { kind: "point", x: math.x, y: math.y });
        }
        rebuild();
    }

    function endDrag(): void {
        active = null;
    }

    function isDragging(): boolean {
        return active !== null;
    }

    return {
        kernel,
        hitTest,
        beginDrag,
        dragTo,
        endDrag,
        isDragging
    };
}

/** Knob math position for a slider, given its static geometry + live value. */
function sliderKnobGeom(sl: SliderGeom, value: number): { x: number; y: number } {
    const range = sl.max - sl.min;
    const t = range > 0 ? (value - sl.min) / range : 0;
    const ex = sl.horizontal ? sl.x + sl.width : sl.x;
    const ey = sl.horizontal ? sl.y : sl.y - sl.width;
    return { x: sl.x + (ex - sl.x) * t, y: sl.y + (ey - sl.y) * t };
}

/**
 * Collect static slider geometry from numeric elements that carry a `<slider>`.
 * Track anchor (x,y) and length (width) are in math coords/units; min/max/step
 * come from the slider child. Built once; knob position is derived per event.
 */
function collectSliderGeometry(items: GgbConstructionItem[]): SliderGeom[] {
    const out: SliderGeom[] = [];
    for (const item of items) {
        if (item.kind !== "element" || item.type !== "numeric") continue;
        const sl = item.slider;
        if (!sl) continue;
        out.push({
            label: item.label,
            x: sl.x ?? 0,
            y: sl.y ?? 0,
            width: sl.width ?? 1,
            horizontal: sl.horizontal ?? true,
            min: sl.min ?? 0,
            max: sl.max ?? 1,
            step: sl.step
        });
    }
    return out;
}
