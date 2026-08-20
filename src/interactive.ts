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

import type { GgbDocument, GgbConstructionItem, GgbElement } from "./types";
import type { SceneBuildOptions, Renderer2D, Viewport2D } from "./render-types";
import { buildScene } from "./scene-builder";
import { Kernel } from "./kernel";
import { Animator, type AnimationConfig } from "./animator";
import { runGgbScript, type ScriptContext } from "./ggbscript";

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
    /**
     * When true, x/y/width are screen pixels (GeoGebra
     * `absoluteScreenLocation`); the slider does not pan/zoom and hit-testing
     * works directly in canvas CSS px. Otherwise they are math coords.
     */
    absolute?: boolean;
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

/** A button declared in the document (caption is live). */
export interface ButtonInfo {
    label: string;
    /** Current caption (mutated by SetCaption scripts). */
    caption: string;
    /** Screen-pixel position from <labelOffset>. */
    x: number;
    y: number;
}

/** Pointer-to-object interaction driver. */
export interface Interactive {
    readonly kernel: Kernel;
    readonly animator: Animator;
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
    /** Buttons declared in the document (captions are live). */
    getButtons(): ButtonInfo[];
    /** Run a button's ggbscript; rebuilds the scene once after. */
    clickButton(label: string): void;
    /** Register for caption/state changes (host re-renders buttons). */
    onUpdate(cb: () => void): void;
    /** Stop animation + cancel rAF (call on unmount). */
    dispose(): void;
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

    // Establish the kernel-driven scene as current.
    renderer.render(buildScene(doc, buildOpts));

    // Slider geometry never changes across drags, so precompute it once
    // from the document. (Knob *position* still comes from the kernel's
    // live value; only the track anchor/length/min/max are static.) This
    // keeps hit-testing off the scene-build hot path.
    const sliders = collectSliderGeometry(doc.construction.items);

    // Numeric elements (for animation config lookup by label).
    const numericByLabel = new Map<string, GgbElement>();
    // Boolean labels (script-level flags like a play/pause toggle).
    const booleanLabels = new Set<string>();
    for (const item of doc.construction.items) {
        if (item.kind !== "element") continue;
        if (item.type === "numeric") numericByLabel.set(item.label, item);
        if (item.type === "boolean") booleanLabels.add(item.label);
    }

    // Runtime boolean state (script-level, defaults to false — matches GeoGebra's
    // default for a new boolean and the `a` toggle in limit.ggb).
    const booleans = new Map<string, boolean>();
    // Live button captions (initialized from parsed <caption>, mutated by SetCaption).
    const captions = new Map<string, string>();
    for (const item of doc.construction.items) {
        if (item.kind === "element" && item.type === "button" && item.caption !== undefined) {
            captions.set(item.label, item.caption);
        }
    }

    // Animation config per free-number label: combines slider bounds with the
    // element's <animation> settings.
    function animationConfig(label: string): AnimationConfig | undefined {
        const bounds = kernel.sliderBounds(label);
        const el = numericByLabel.get(label);
        const anim = el?.animation;
        if (!bounds) return undefined;
        const step = anim?.step ?? bounds.step ?? 1;
        return {
            min: bounds.min,
            max: bounds.max,
            step: step > 0 ? step : 1,
            speed: anim?.speed ?? 1,
            type: anim?.type ?? 3
        };
    }

    // Active drag state.
    let active: HitTarget | null = null;
    let updateCb: (() => void) | undefined;

    function rebuild(): void {
        const scene = buildScene(doc, buildOpts);
        renderer.updateScene(scene);
    }

    // ScriptContext: bridges the ggbscript interpreter to the kernel + animator.
    const ctx: ScriptContext = {
        getValue: (label) => kernel.getValue(label),
        setValue: (label, value) => {
            // A manual value change (e.g. the reset button's `n = 1`) halts any
            // running animation on that label — GeoGebra stops animating a slider
            // once its value is set by hand. The animator's own per-frame writes
            // go straight through kernel.setValue, so they do not self-interrupt.
            if (animator.isPlaying(label)) animator.stop(label);
            kernel.setValue(label, value);
        },
        isFree: (label) => kernel.isFree(label),
        getBoolean: (label) => booleans.get(label) ?? false,
        setBoolean: (label, value) => booleans.set(label, value),
        isBoolean: (label) => booleanLabels.has(label),
        startAnimation: (label, play) => {
            if (play) animator.start(label);
            else animator.stop(label);
        },
        setCaption: (label, text) => {
            captions.set(label, text);
            updateCb?.();
        }
    };

    // Owns the single rAF loop; each frame advances the animated slider and
    // rebuilds the scene, reusing the same reactivity chain as dragTo.
    const animator = new Animator({
        getValue: (label) => {
            const v = kernel.getValue(label);
            return v?.kind === "number" ? v.value : undefined;
        },
        setValue: (label, value) => kernel.setValue(label, { kind: "number", value }),
        config: animationConfig,
        rebuild
    });

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
            const { x: kx, y: ky } = sliderKnobPx(sl, value, vp);
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
            // Absolute sliders live in screen pixels, so use the pointer's
            // canvas px directly instead of converting to math coords.
            const originX = sl.absolute ? cx : math.x;
            const originY = sl.absolute ? cy : math.y;
            const along = sl.horizontal
                ? (originX - sl.x) / sl.width
                : (sl.y - originY) / sl.width;
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

    function getButtons(): ButtonInfo[] {
        const out: ButtonInfo[] = [];
        for (const item of doc.construction.items) {
            if (item.kind !== "element" || item.type !== "button") continue;
            out.push({
                label: item.label,
                caption: captions.get(item.label) ?? item.caption ?? "",
                x: item.labelOffset?.x ?? 0,
                y: item.labelOffset?.y ?? 0
            });
        }
        return out;
    }

    function clickButton(label: string): void {
        const item = doc.construction.items.find(
            (it) => it.kind === "element" && it.type === "button" && it.label === label
        );
        if (item?.kind !== "element") return;
        runGgbScript(item.ggbscript ?? "", ctx);
        // Apply any value side-effects (e.g. `n = 1`) to the scene.
        rebuild();
    }

    function onUpdate(cb: () => void): void {
        updateCb = cb;
    }

    function dispose(): void {
        animator.dispose();
    }

    return {
        kernel,
        animator,
        hitTest,
        beginDrag,
        dragTo,
        endDrag,
        isDragging,
        getButtons,
        clickButton,
        onUpdate,
        dispose
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
 * Knob position in canvas CSS pixels. For absolute sliders the geometry is
 * already screen pixels (identity); otherwise the math-coord knob is mapped
 * through the viewport like any other math object.
 */
function sliderKnobPx(
    sl: SliderGeom,
    value: number,
    vp: Viewport2D
): { x: number; y: number } {
    if (sl.absolute) return sliderKnobGeom(sl, value);
    const m = sliderKnobGeom(sl, value);
    return { x: vp.xZero + m.x * vp.scaleX, y: vp.yZero - m.y * vp.scaleY };
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
            absolute: sl.absolute,
            min: sl.min ?? 0,
            max: sl.max ?? 1,
            // GeoGebra sliders may omit an explicit increment on <slider>;
            // in that case the <animation step="..."> is the only declared
            // granularity, so fall back to it — otherwise dragging would be
            // unquantized while the animator steps at 0.1 (e.g. the tangent
            // demo's slider a, which has no <slider step> but animates by 0.1).
            step: sl.step ?? item.animation?.step
        });
    }
    return out;
}
