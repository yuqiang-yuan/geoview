/**
 * geoview — Slider animation driver.
 *
 * GeoGebra sliders can carry an `<animation step speed type playing/>` child
 * that drives the value over time (e.g. the "开始" button in limit.ggb starts
 * `n` animating 1→40). The animator owns a single requestAnimationFrame loop
 * that, while at least one slider is playing, advances its value and pushes it
 * back through the kernel via {@link AnimatorDeps.setValue} (which re-evaluates
 * dependents and rebuilds the scene — the same reactivity chain `dragTo` uses).
 *
 * Animations are increasing: increment by `step` and STOP at `max` (no loop).
 * The rate is `speed * step * RATE` units per second of wall-clock time; the
 * `RATE` multiplier speeds the baseline up from GeoGebra's slow 1-step/s default
 * so a 1→40 slider like limit.ggb's `n` completes in a few seconds rather than
 * ~40s. Reaching `max` halts the label's animation.
 */

/** Baseline steps-per-second multiplier for `speed=1, step=1` (tunable). */
const RATE = 8;

/** Per-label animation settings (combined from slider bounds + <animation>). */
export interface AnimationConfig {
    min: number;
    max: number;
    step: number;
    speed: number;
    type: number;
}

/** Host-provided operations the animator needs to read/write values + redraw. */
export interface AnimatorDeps {
    /** Read the label's current numeric value. */
    getValue: (label: string) => number | undefined;
    /** Write the next value (delegates to kernel.setValue + triggers rebuild). */
    setValue: (label: string, value: number) => void;
    /** Animation config per label, or undefined if the label is not animatable. */
    config: (label: string) => AnimationConfig | undefined;
    /** Rebuild + re-render the scene after a value change. */
    rebuild: () => void;
}

interface Playing {
    lastTs: number;
    /** Whether lastTs has been primed with a real timestamp. */
    primed: boolean;
    /** Accumulated fractional step budget (in value units). */
    acc: number;
}

/**
 * Drives animated sliders via requestAnimationFrame. One instance per
 * interactive session; construct via {@link Animator} and dispose on unmount.
 */
export class Animator {
    private playing = new Map<string, Playing>();
    private rafId: number | null = null;

    constructor(private deps: AnimatorDeps) {}

    start(label: string): void {
        if (this.playing.has(label)) return;
        const cfg = this.deps.config(label);
        if (!cfg) return;
        this.playing.set(label, { lastTs: 0, primed: false, acc: 0 });
        if (this.rafId === null) {
            this.rafId = requestAnimationFrame(this.tick);
        }
    }

    stop(label: string): void {
        this.playing.delete(label);
        if (this.playing.size === 0 && this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    stopAll(): void {
        this.playing.clear();
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    isPlaying(label?: string): boolean {
        if (label === undefined) return this.playing.size > 0;
        return this.playing.has(label);
    }

    dispose(): void {
        this.stopAll();
    }

    private tick = (ts: number): void => {
        for (const [label, entry] of this.playing) {
            const cfg = this.deps.config(label);
            if (!cfg) {
                this.stop(label);
                continue;
            }
            if (!entry.primed) {
                entry.lastTs = ts;
                entry.primed = true;
                continue;
            }
            const dt = (ts - entry.lastTs) / 1000;
            entry.lastTs = ts;
            entry.acc += dt * cfg.speed * cfg.step * RATE;

            let cur = this.deps.getValue(label) ?? cfg.min;
            const step = cfg.step;
            // Advance by whole steps accumulated this frame.
            let reachedMax = false;
            let guard = 0;
            while (entry.acc >= step && guard++ < 1000) {
                entry.acc -= step;
                cur += step;
                // Increasing animation stops at max (does not loop back to min).
                if (cur >= cfg.max) {
                    cur = cfg.max;
                    reachedMax = true;
                    entry.acc = 0;
                    break;
                }
            }
            // Snap to step granularity and clamp.
            cur = cfg.min + Math.round((cur - cfg.min) / step) * step;
            if (cur < cfg.min) cur = cfg.min;
            if (cur > cfg.max) cur = cfg.max;

            this.deps.setValue(label, cur);
            if (reachedMax) this.stop(label);
        }
        this.deps.rebuild();

        if (this.playing.size > 0) {
            this.rafId = requestAnimationFrame(this.tick);
        } else {
            this.rafId = null;
        }
    };
}
