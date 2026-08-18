/**
 * geoview — GeoGebra script (ggbscript) subset interpreter.
 *
 * GeoGebra buttons carry a `<ggbscript val="..."/>` whose statements are
 * separated by newlines (the XML entity `&#xD;&#xA;` decodes to CRLF). This
 * module evaluates a generic subset of that language against a host-provided
 * {@link ScriptContext}, so the same interpreter works for any button — not
 * just a specific file.
 *
 * Supported statements:
 *  - Assignment:        `label = expr`
 *  - StartAnimation:     `StartAnimation[label, boolExpr?]`
 *  - SetCaption:         `SetCaption[label, textExpr]`
 *
 * Supported expressions:
 *  - `!expr`             boolean negation
 *  - `If(c, t, e)`       conditional (parens or square brackets)
 *  - `"…"`               string literal
 *  - number literal
 *  - bare identifier     resolved via the context (boolean or number)
 *
 * Booleans live in the host layer (script-level flags like a play/pause
 * toggle), not the kernel: a label is a boolean if the context says so, else a
 * free number/point when `isFree` holds. Unknown statements are ignored.
 */

import type { ResolvedValue } from "./render-types";

/** Operations the interpreter needs from its host (the interactive layer). */
export interface ScriptContext {
    /** Read a resolved kernel value (number/point/list). */
    getValue(label: string): ResolvedValue | undefined;
    /** Write a free number/point (delegates to kernel.setValue). */
    setValue(
        label: string,
        value: { kind: "number"; value: number } | { kind: "point"; x: number; y: number }
    ): void;
    /** Is this label a free (kernel-owned) number/point? */
    isFree(label: string): boolean;
    /** Runtime booleans (script-level, default false). */
    getBoolean(label: string): boolean;
    setBoolean(label: string, value: boolean): void;
    isBoolean(label: string): boolean;
    /** Animation control (delegates to the animator). */
    startAnimation(label: string, play: boolean): void;
    /** Caption update (button label text). */
    setCaption(label: string, text: string): void;
}

/** A small tagged value produced by expression evaluation. */
type EvalValue =
    | { kind: "boolean"; value: boolean }
    | { kind: "number"; value: number }
    | { kind: "string"; value: string };

/**
 * Run a ggbscript string against a context. Statements execute in order; a
 * failing statement is silently skipped (GeoGebra is similarly permissive).
 */
export function runGgbScript(script: string, ctx: ScriptContext): void {
    const src = script.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (const raw of src.split("\n")) {
        const stmt = raw.trim();
        if (!stmt) continue;
        try {
            execStatement(stmt, ctx);
        } catch {
            // Ignore unparseable statements.
        }
    }
}

// ============================================================
// Statement dispatch
// ============================================================

function execStatement(stmt: string, ctx: ScriptContext): void {
    // Command call: Name[args]  (GeoGebra uses square brackets for commands)
    const call = matchCall(stmt);
    if (call) {
        const name = call.name;
        const args = splitTopLevel(call.inner);
        if (name === "StartAnimation") {
            const label = args[0]?.trim() ?? "";
            const play = args.length > 1 ? evalBoolean(args[1], ctx) : true;
            ctx.startAnimation(label, play);
            return;
        }
        if (name === "SetCaption") {
            const label = args[0]?.trim() ?? "";
            const text = args.length > 1 ? evalText(args[1], ctx) : "";
            ctx.setCaption(label, text);
            return;
        }
        // Unknown command — ignore.
        return;
    }

    // Assignment: label = expr  (split on first top-level single `=`)
    const eq = findAssignEq(stmt);
    if (eq >= 0) {
        const label = stmt.slice(0, eq).trim();
        const expr = stmt.slice(eq + 1).trim();
        assign(label, expr, ctx);
        return;
    }

    // Otherwise: ignore.
}

function assign(label: string, expr: string, ctx: ScriptContext): void {
    const value = evalExpr(expr, ctx);
    if (value === undefined) return;
    if (ctx.isBoolean(label)) {
        ctx.setBoolean(label, evalBoolean(expr, ctx));
        return;
    }
    if (ctx.isFree(label)) {
        if (value.kind === "number") {
            ctx.setValue(label, { kind: "number", value: value.value });
        }
        return;
    }
    // Unknown target — ignore.
}

// ============================================================
// Expression evaluation
// ============================================================

function evalExpr(s: string, ctx: ScriptContext): EvalValue | undefined {
    const t = s.trim();
    if (!t) return undefined;

    // Negation: !expr
    if (t.startsWith("!")) {
        return { kind: "boolean", value: !evalBoolean(t.slice(1), ctx) };
    }

    // If(cond, then, else) — parens or brackets
    const ifCall = matchNamedCall(t, "If");
    if (ifCall) {
        const args = splitTopLevel(ifCall.inner);
        const cond = evalBoolean(args[0] ?? "", ctx);
        const thenText = args[1] ?? "";
        const elseText = args[2] ?? "";
        return { kind: "string", value: evalText(cond ? thenText : elseText, ctx) };
    }

    // String literal
    if (t.startsWith('"')) {
        return { kind: "string", value: unquote(t) };
    }

    // Number literal
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
        return { kind: "number", value: Number(t) };
    }

    // Bare identifier → boolean or number
    if (isIdentifier(t)) {
        if (ctx.isBoolean(t)) {
            return { kind: "boolean", value: ctx.getBoolean(t) };
        }
        if (ctx.isFree(t)) {
            const v = ctx.getValue(t);
            if (v?.kind === "number") {
                return { kind: "number", value: v.value };
            }
        }
        return undefined;
    }

    return undefined;
}

function evalBoolean(s: string, ctx: ScriptContext): boolean {
    const v = evalExpr(s, ctx);
    if (!v) return false;
    switch (v.kind) {
        case "boolean":
            return v.value;
        case "number":
            return v.value !== 0;
        case "string":
            return v.value.length > 0;
    }
}

function evalText(s: string, ctx: ScriptContext): string {
    const v = evalExpr(s, ctx);
    if (v?.kind === "string") return v.value;
    if (v?.kind === "number") return String(v.value);
    if (v?.kind === "boolean") return String(v.value);
    return unquote(s.trim());
}

// ============================================================
// Helpers
// ============================================================

/** Split a string on top-level commas (respecting ()[]{} and string literals). */
function splitTopLevel(s: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inString = false;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "," && depth === 0) {
            parts.push(s.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(s.slice(start));
    return parts.map((p) => p.trim());
}

/** Match `Name[...]` or `Name(...)`, returning the name and the bracket contents. */
function matchCall(s: string): { name: string; inner: string } | undefined {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*([(\[])/.exec(s);
    if (!m) return undefined;
    const name = m[1];
    const open = m[2];
    const close = open === "(" ? ")" : "]";
    const openIdx = s.indexOf(open);
    if (openIdx < 0) return undefined;
    const closeIdx = findMatching(s, openIdx, open, close);
    if (closeIdx < 0) return undefined;
    return { name, inner: s.slice(openIdx + 1, closeIdx) };
}

/** Match a specific `Name[...]`/`Name(...)` call (used for `If`). */
function matchNamedCall(s: string, name: string): { inner: string } | undefined {
    const m = new RegExp(`^${name}\\s*([\\(\\[])`).exec(s);
    if (!m) return undefined;
    const open = m[1];
    const close = open === "(" ? ")" : "]";
    const openIdx = s.indexOf(open);
    if (openIdx < 0) return undefined;
    const closeIdx = findMatching(s, openIdx, open, close);
    if (closeIdx < 0) return undefined;
    return { inner: s.slice(openIdx + 1, closeIdx) };
}

/** Find the matching closing bracket for the bracket at `openIdx`. */
function findMatching(s: string, openIdx: number, open: string, close: string): number {
    let depth = 0;
    let inString = false;
    for (let i = openIdx; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === open || ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === close || ch === ")" || ch === "]" || ch === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** Find the index of the first top-level single `=` that is an assignment. */
function findAssignEq(s: string): number {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (inString) {
            if (ch === "\\" && i + 1 < s.length) {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "=" && depth === 0) {
            // Skip comparison operators.
            const prev = s[i - 1];
            const next = s[i + 1];
            if (prev === "=" || prev === "!" || prev === "<" || prev === ">" || prev === ">") continue;
            if (next === "=") continue;
            return i;
        }
    }
    return -1;
}

function isIdentifier(s: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_']*$/.test(s);
}

/** Strip surrounding quotes and unescape common entities. */
function unquote(s: string): string {
    let t = s.trim();
    if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
        t = t.slice(1, -1);
    }
    return t.replace(/&quot;/g, '"').replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}
