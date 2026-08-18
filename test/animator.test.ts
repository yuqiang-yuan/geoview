/**
 * Animator tests.
 *
 * The Animator drives a requestAnimationFrame loop. In Node there is no rAF,
 * so this test installs a fake one whose queue is flushed manually with a
 * controllable timestamp — making the wall-clock advancement deterministic.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Animator, type AnimatorDeps, type AnimationConfig } from "../src/index";

interface Recorded {
    label: string;
    value: number;
}

function makeDeps(config: AnimationConfig, startValue: number): AnimatorDeps & {
    recorded: Recorded[];
    current: number;
} {
    let current = startValue;
    const recorded: Recorded[] = [];
    return {
        recorded,
        current,
        getValue: () => current,
        setValue: (_label, value) => {
            current = value;
            recorded.push({ label: _label, value });
        },
        config: () => config,
        rebuild: () => {}
    };
}

let rafQueue: Array<(ts: number) => void> = [];
let originalRAF: typeof globalThis.requestAnimationFrame | undefined;
let originalCAF: typeof globalThis.cancelAnimationFrame | undefined;

function installFakeRaf() {
    rafQueue = [];
    originalRAF = globalThis.requestAnimationFrame;
    originalCAF = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: (ts: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {
        rafQueue = [];
    }) as typeof globalThis.cancelAnimationFrame;
}

function restoreRaf() {
    if (originalRAF) globalThis.requestAnimationFrame = originalRAF;
    if (originalCAF) globalThis.cancelAnimationFrame = originalCAF;
}

/** Run a single scheduled rAF callback at the given timestamp.
 * The animator reschedules itself each frame, so the queue always holds at
 * most one pending callback; calling flush(ts) advances exactly one frame. */
function flush(ts: number): void {
    const cb = rafQueue.shift();
    if (cb) cb(ts);
}

afterEach(restoreRaf);

describe("Animator", () => {
    it("advances n by RATE steps after ~1 second (step=1, speed=1, RATE=8)", () => {
        installFakeRaf();
        const deps = makeDeps({ min: 1, max: 40, step: 1, speed: 1, type: 3 }, 1);
        const animator = new Animator(deps);
        animator.start("n");
        // First frame primes lastTs (no advance).
        flush(0);
        // Advance 1 second → 8 steps → value 9.
        flush(1000);
        expect(deps.recorded.some((r) => r.value === 9)).toBe(true);
        animator.dispose();
    });

    it("stops at max instead of looping past it", () => {
        installFakeRaf();
        const deps = makeDeps({ min: 1, max: 40, step: 1, speed: 1, type: 3 }, 40);
        const animator = new Animator(deps);
        animator.start("n");
        flush(0);
        // Already at max → next frame clamps to 40 and stops (no wrap to 1).
        flush(1000);
        expect(deps.recorded.some((r) => r.value === 1)).toBe(false);
        expect(deps.recorded.some((r) => r.value === 40)).toBe(true);
        expect(animator.isPlaying("n")).toBe(false);
        animator.dispose();
    });

    it("stop halts the loop", () => {
        installFakeRaf();
        const deps = makeDeps({ min: 1, max: 40, step: 1, speed: 1, type: 3 }, 1);
        const animator = new Animator(deps);
        animator.start("n");
        flush(0);
        flush(1000);
        animator.stop("n");
        const countBefore = deps.recorded.length;
        flush(2000);
        flush(3000);
        expect(deps.recorded.length).toBe(countBefore);
        expect(animator.isPlaying("n")).toBe(false);
    });
});
