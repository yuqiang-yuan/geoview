/**
 * ggbscript interpreter tests.
 *
 * Uses a mock ScriptContext that captures side-effect calls, verifying the
 * generic subset interpreter handles assignment, StartAnimation, SetCaption,
 * `!` negation, and If(...) — the exact statements in limit.ggb's buttons.
 */
import { describe, it, expect } from "vitest";
import { runGgbScript, type ScriptContext } from "../src/index";

interface Call {
    op: string;
    args: unknown[];
}

function makeCtx(booleans: Record<string, boolean> = {}): ScriptContext & { calls: Call[] } {
    const calls: Call[] = [];
    const bools = new Map(Object.entries(booleans));
    return {
        calls,
        getValue: () => undefined,
        setValue: (label, value) => calls.push({ op: "setValue", args: [label, value] }),
        isFree: (label) => label === "n",
        getBoolean: (label) => bools.get(label) ?? false,
        setBoolean: (label, value) => {
            bools.set(label, value);
            calls.push({ op: "setBoolean", args: [label, value] });
        },
        isBoolean: (label) => label === "a",
        startAnimation: (label, play) => calls.push({ op: "startAnimation", args: [label, play] }),
        setCaption: (label, text) => calls.push({ op: "setCaption", args: [label, text] })
    };
}

describe("runGgbScript - limit.ggb start button", () => {
    const script = 'a=!a\r\nStartAnimation[n,a]\r\nSetCaption[button1,If(a,"暂停","开始")]';

    it("toggles a on, starts animation, sets caption to 暂停", () => {
        const ctx = makeCtx({ a: false });
        runGgbScript(script, ctx);
        expect(ctx.calls).toContainEqual({ op: "setBoolean", args: ["a", true] });
        expect(ctx.calls).toContainEqual({ op: "startAnimation", args: ["n", true] });
        expect(ctx.calls).toContainEqual({ op: "setCaption", args: ["button1", "暂停"] });
    });

    it("toggles a off, stops animation, sets caption to 开始", () => {
        const ctx = makeCtx({ a: true });
        runGgbScript(script, ctx);
        expect(ctx.calls).toContainEqual({ op: "setBoolean", args: ["a", false] });
        expect(ctx.calls).toContainEqual({ op: "startAnimation", args: ["n", false] });
        expect(ctx.calls).toContainEqual({ op: "setCaption", args: ["button1", "开始"] });
    });
});

describe("runGgbScript - reset button", () => {
    it("assigns n=1 via setValue", () => {
        const ctx = makeCtx();
        runGgbScript("n=1", ctx);
        expect(ctx.calls).toContainEqual({
            op: "setValue",
            args: ["n", { kind: "number", value: 1 }]
        });
    });
});
