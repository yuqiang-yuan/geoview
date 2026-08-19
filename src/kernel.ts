/**
 * geoview — Reactive evaluation kernel.
 *
 * GeoGebra's construction is a dependency graph: objects depend on free
 * values (points, sliders) and on each other via expressions/commands.
 * The XML stores the *recipe*, not the computed result for command outputs
 * (e.g. `FitPoly`), and stores computed coords for derived points only at
 * save time — which go stale the moment a free value changes.
 *
 * The kernel re-evaluates the whole construction in document order (order
 * encodes dependencies) against a symbol scope, producing a label→value map
 * the scene builder renders from. When a free value is dragged, `setValue`
 * records an override and the construction is re-evaluated, so dependents
 * (fitted curves, derived points, conditional visibility) update live.
 *
 * Value model:
 *  - number  : slider / numeric
 *  - point   : { x, y }
 *  - function: { evaluate, expression }  (FitPoly output or f(x)=... expr)
 *
 * Expressions are evaluated with mathjs. GeoGebra point tuples `(X, Y)` are
 * rewritten to mathjs arrays `[X, Y]` so elementwise point arithmetic
 * (`F - (0.1, 0.2)`) and function calls inside tuples (`f(1 + δ)`) work.
 */

import type { GgbDocument, GgbConstructionItem, GgbElement, GgbExpression } from "./types";
import { extractExpression, ggbToMathJs, compileMath, GGB_POW_SCOPE } from "./sampler";
import { fitPoly } from "./fitpoly";

// ============================================================
// Resolved values
// ============================================================

export interface NumberValue {
    kind: "number";
    value: number;
}

export interface PointValue {
    kind: "point";
    x: number;
    y: number;
}

export interface FunctionValue {
    kind: "function";
    /** Evaluate the function at x (closed over its coefficients/scope). */
    evaluate: (x: number) => number;
    /** Canonical expression string for the sampler/renderer. */
    expression: string;
}

export interface ListValue {
    kind: "list";
    /** Ordered points (Sequence-of-points is the use case). */
    points: Array<{ x: number; y: number }>;
}

export type ResolvedValue = NumberValue | PointValue | FunctionValue | ListValue;

/** A free (draggable) object: a point or a slider. */
export interface FreeObject {
    label: string;
    kind: "point" | "number";
}

// ============================================================
// Recipes (how each label is computed)
// ============================================================

type Recipe =
    | { kind: "free-point"; exp: string; initialValue: PointValue }
    | { kind: "free-number"; min: number; max: number; step?: number; initialValue: number }
    | { kind: "derived-point"; exp: string }
    | { kind: "function-expr"; rhs: string }
    | { kind: "fitpoly"; pointLabels: string[]; degree: number }
    | { kind: "sequence"; expr: string; varName: string; startExpr: string; endExpr: string; stepExpr?: string };

// ============================================================
// Kernel
// ============================================================

/**
 * A reactive evaluator for a parsed construction.
 */
export class Kernel {
    private recipes = new Map<string, Recipe>();
    private order: string[] = [];
    private values = new Map<string, ResolvedValue>();
    /** Free-value overrides set by dragging (label → value). */
    private overrides = new Map<string, ResolvedValue>();

    constructor(doc: GgbDocument) {
        this.buildRecipes(doc.construction.items);
        this.evaluate();
    }

    // --- public API ---

    /** Re-evaluate the whole construction; returns the value map. */
    evaluate(): Map<string, ResolvedValue> {
        this.values.clear();
        for (const label of this.order) {
            if (this.overrides.has(label)) {
                this.values.set(label, this.overrides.get(label)!);
                continue;
            }
            const recipe = this.recipes.get(label);
            if (!recipe) continue;
            const value = this.compute(recipe, label);
            if (value) this.values.set(label, value);
        }
        return this.values;
    }

    /** Get the resolved value for a label. */
    getValue(label: string): ResolvedValue | undefined {
        return this.values.get(label);
    }

    /** Is this label a free (draggable) point or slider? */
    isFree(label: string): boolean {
        const r = this.recipes.get(label);
        return r?.kind === "free-point" || r?.kind === "free-number";
    }

    /** All free (draggable) objects. */
    freeObjects(): FreeObject[] {
        const out: FreeObject[] = [];
        for (const label of this.order) {
            const r = this.recipes.get(label);
            if (r?.kind === "free-point") out.push({ label, kind: "point" });
            else if (r?.kind === "free-number") out.push({ label, kind: "number" });
        }
        return out;
    }

    /** Slider bounds for a free-number label. */
    sliderBounds(label: string): { min: number; max: number; step?: number } | undefined {
        const r = this.recipes.get(label);
        if (r?.kind !== "free-number") return undefined;
        return { min: r.min, max: r.max, step: r.step };
    }

    /**
     * Set a free value (from dragging) and re-evaluate dependents.
     * For points pass {x,y}; for sliders pass a number (clamped/snapped).
     */
    setValue(label: string, value: ResolvedValue): void {
        if (!this.isFree(label)) return;
        this.overrides.set(label, value);
        this.evaluate();
    }

    /**
     * Evaluate a GeoGebra point expression (e.g. `"F - (0.1, 0.2)"`) against
     * the current values, returning live {x,y}. Used to resolve text anchors
     * that depend on free objects, so labels track dragging. Returns undefined
     * when the expression cannot be evaluated.
     */
    evalPoint(exp: string | undefined): PointValue | undefined {
        if (!exp) return undefined;
        return evalPointExpr(exp, this.buildScope());
    }

    /** Evaluate a `<condition showObject="..."/>` expression to a boolean. */
    evalCondition(cond: string | undefined): boolean {
        if (!cond) return true;
        try {
            const compiled = compileMath(ggbToMathJs(cond));
            const r = compiled.evaluate(this.buildScope());
            return Boolean(r);
        } catch {
            return true;
        }
    }

    // --- recipe construction ---

    private buildRecipes(items: GgbConstructionItem[]): void {
        const exprByLabel = new Map<string, GgbExpression>();
        const elementByLabel = new Map<string, GgbElement>();
        const commandByOutput = new Map<string, { name: string; input: string[] }>();

        for (const item of items) {
            if (item.kind === "expression") {
                exprByLabel.set(item.label, item);
                if (!this.order.includes(item.label)) this.order.push(item.label);
            } else if (item.kind === "element") {
                elementByLabel.set(item.label, item);
                if (!this.order.includes(item.label)) this.order.push(item.label);
            } else if (item.kind === "command") {
                for (const out of item.output) {
                    commandByOutput.set(out, { name: item.name, input: item.input });
                    if (!this.order.includes(out)) this.order.push(out);
                }
            }
        }

        for (const label of this.order) {
            const cmd = commandByOutput.get(label);
            const el = elementByLabel.get(label);
            const expr = exprByLabel.get(label);
            const recipe = this.makeRecipe(label, cmd, el, expr);
            if (recipe) this.recipes.set(label, recipe);
        }
    }

    private makeRecipe(
        label: string,
        cmd: { name: string; input: string[] } | undefined,
        el: GgbElement | undefined,
        expr: GgbExpression | undefined
    ): Recipe | undefined {
        // Command-produced objects: only FitPoly yields a kernel value here.
        // (Segment/Text/Intersect etc. are resolved structurally by the
        // scene builder from the point values the kernel exposes.)
        if (cmd) {
            if (cmd.name === "FitPoly") {
                const labels = parsePointList(cmd.input[0] ?? "");
                const degree = cmd.input[1] !== undefined
                    ? parseInt(cmd.input[1], 10)
                    : Math.max(0, labels.length - 1);
                return { kind: "fitpoly", pointLabels: labels, degree: Number.isFinite(degree) ? degree : labels.length - 1 };
            }
            if (cmd.name === "Sequence") {
                // input: [expr, var, start, end, step?]
                return {
                    kind: "sequence",
                    expr: cmd.input[0] ?? "",
                    varName: cmd.input[1] ?? "i",
                    startExpr: cmd.input[2] ?? "1",
                    endExpr: cmd.input[3] ?? "1",
                    stepExpr: cmd.input[4]
                };
            }
            return undefined;
        }

        // Numeric / slider object.
        if (el?.type === "numeric") {
            const sl = el.slider;
            const min = sl?.min ?? 0;
            const max = sl?.max ?? 1;
            const initial = el.value ?? min;
            return { kind: "free-number", min, max, step: sl?.step, initialValue: initial };
        }

        // Point object: expression tuple, else stored coords.
        if (el?.type === "point" || expr?.type === "point") {
            if (expr?.exp) {
                // Free if the expression evaluates with an empty scope
                // (references no other label, e.g. "(1, 2.77)").
                const free = evalPointConst(expr.exp);
                if (free) {
                    return { kind: "free-point", exp: expr.exp, initialValue: free };
                }
                return { kind: "derived-point", exp: expr.exp };
            }
            // Element-only point: use stored coords as a free point.
            if (el?.coords) {
                const z = el.coords.z || 1;
                return {
                    kind: "free-point",
                    exp: `(${el.coords.x / z}, ${el.coords.y / z})`,
                    initialValue: { kind: "point", x: el.coords.x / z, y: el.coords.y / z }
                };
            }
            return undefined;
        }

        // Function defined directly by an expression f(x) = ...
        if (el?.type === "function" || expr?.type === "function") {
            if (expr?.exp && expr.exp.includes("=")) {
                return { kind: "function-expr", rhs: extractExpression(expr.exp) };
            }
            return undefined; // produced by a command (e.g. FitPoly) or no expr
        }

        // Bare function-like expression without type (e.g. "h(x) = ...").
        if (expr?.exp && !expr.type && expr.exp.includes("(") && expr.exp.includes("=")) {
            return { kind: "function-expr", rhs: extractExpression(expr.exp) };
        }

        return undefined;
    }

    // --- evaluation ---

    private compute(recipe: Recipe, label: string): ResolvedValue | undefined {
        switch (recipe.kind) {
            case "free-point":
                return recipe.initialValue;
            case "free-number":
                return { kind: "number", value: recipe.initialValue };
            case "derived-point":
                return evalPointExpr(recipe.exp, this.buildScope());
            case "function-expr":
                return this.makeFunctionValue(recipe.rhs);
            case "fitpoly": {
                const pts = recipe.pointLabels
                    .map((l) => this.values.get(l))
                    .filter((v): v is PointValue => v?.kind === "point")
                    .map((v) => ({ x: v.x, y: v.y }));
                if (pts.length === 0) return undefined;
                const fit = fitPoly(pts, recipe.degree);
                return { kind: "function", evaluate: fit.evaluate, expression: fit.expression };
            }
            case "sequence": {
                const scope = this.buildScope();
                const start = evalNumber(recipe.startExpr, scope);
                const end = evalNumber(recipe.endExpr, scope);
                if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
                const step = recipe.stepExpr ? evalNumber(recipe.stepExpr, scope) : 1;
                if (!step || !Number.isFinite(step) || step === 0) return undefined;
                const points: Array<{ x: number; y: number }> = [];
                const dir = step > 0 ? 1 : -1;
                // Guard against runaway loops (e.g. huge end with tiny step).
                const maxIter = 100000;
                let v = start;
                let iter = 0;
                while (dir > 0 ? v <= end : v >= end) {
                    if (iter++ > maxIter) break;
                    const pt = evalPointExpr(recipe.expr, { ...scope, [recipe.varName]: v });
                    if (pt) points.push({ x: pt.x, y: pt.y });
                    v += step;
                }
                return { kind: "list", points };
            }
        }
    }

    /**
     * Build a function value whose evaluate closes over the current scope
     * (so a function referencing a slider/number re-reads it on each call).
     */
    private makeFunctionValue(rhs: string): FunctionValue {
        const compiled = compileMath(ggbToMathJs(rhs));
        const scope = this.buildScope();
        return {
            kind: "function",
            evaluate: (x: number) => {
                try {
                    const r = compiled.evaluate({ x, ...scope });
                    return typeof r === "number" ? r : extractNumber(r);
                } catch {
                    return NaN;
                }
            },
            expression: rhs
        };
    }

    /**
     * Build the mathjs symbol scope from currently-resolved values:
     * numbers → number, functions → JS fn, points → [x, y].
     */
    private buildScope(): Record<string, unknown> {
        const scope: Record<string, unknown> = {};
        for (const [label, value] of this.values) {
            switch (value.kind) {
                case "number":
                    scope[label] = value.value;
                    break;
                case "point":
                    scope[label] = [value.x, value.y];
                    break;
                case "function":
                    scope[label] = value.evaluate;
                    break;
                case "list":
                    // Lists are not referenced by other expressions.
                    break;
            }
        }
        // Provide the real-branch power helper so expressions compiled with
        // compileMath (e.g. `a^(1/3)`) resolve `^` to it — otherwise a point
        // like `A = (a, f(a))` evaluates complex for a < 0 and vanishes.
        return { ...scope, ...GGB_POW_SCOPE };
    }
}

// ============================================================
// Expression evaluation helpers
// ============================================================

/**
 * Rewrite GeoGebra point tuples `(X, Y)` to mathjs arrays `[X, Y]`,
 * leaving function-call and grouping parentheses intact. A tuple is a
 * parenthesised group whose content has a top-level comma (a comma at
 * the group's own depth). Handles nested calls like `(1, f(1 + δ))` —
 * the outer pair has a top-level comma (→ array), the inner `f(...)`
 * does not (→ stays a call).
 */
function convertTuplesToArrays(s: string): string {
    // Find all matched paren pairs.
    const stack: number[] = [];
    const pairs: Array<{ open: number; close: number }> = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") stack.push(i);
        else if (s[i] === ")" && stack.length) pairs.push({ open: stack.pop()!, close: i });
    }

    // Mark pairs whose content has a top-level comma (a tuple).
    const markOpen = new Set<number>();
    const markClose = new Set<number>();
    for (const { open, close } of pairs) {
        let depth = 0;
        let hasComma = false;
        for (let i = open + 1; i < close; i++) {
            const c = s[i];
            if (c === "(" || c === "[") depth++;
            else if (c === ")" || c === "]") depth--;
            else if (c === "," && depth === 0) { hasComma = true; break; }
        }
        if (hasComma) {
            markOpen.add(open);
            markClose.add(close);
        }
    }

    let out = "";
    for (let i = 0; i < s.length; i++) {
        if (markOpen.has(i)) out += "[";
        else if (markClose.has(i)) out += "]";
        else out += s[i];
    }
    return out;
}

/** Extract a JS number from a mathjs result (Complex/Unit/Matrix fallback). */
function extractNumber(r: unknown): number {
    if (typeof r === "number") return r;
    if (r && typeof (r as { valueOf?: () => unknown }).valueOf === "function") {
        const v = (r as { valueOf: () => unknown }).valueOf();
        if (typeof v === "number") return v;
    }
    return NaN;
}

/** Evaluate a GeoGebra numeric expression against a scope (e.g. Sequence bounds). */
function evalNumber(exp: string, scope: Record<string, unknown>): number {
    try {
        const compiled = compileMath(ggbToMathJs(exp));
        return extractNumber(compiled.evaluate(scope));
    } catch {
        return NaN;
    }
}

/** Extract {x,y} from a mathjs evaluation result (DenseMatrix / array). */
function extractPoint(r: unknown): PointValue | undefined {
    if (r && typeof r === "object" && "toArray" in r) {
        const arr = (r as { toArray: () => unknown[] }).toArray();
        const x = Number(arr[0]);
        const y = Number(arr[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) return { kind: "point", x, y };
    }
    if (Array.isArray(r)) {
        const x = Number(r[0]);
        const y = Number(r[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) return { kind: "point", x, y };
    }
    return undefined;
}

/**
 * Evaluate a GeoGebra point expression against a scope.
 * Handles tuples `(X, Y)`, point arithmetic (`F - (0.1, 0.2)`), and
 * function calls inside coordinates (`f(1 + δ)`).
 */
function evalPointExpr(exp: string, scope: Record<string, unknown>): PointValue | undefined {
    try {
        const compiled = compileMath(convertTuplesToArrays(ggbToMathJs(exp)));
        return extractPoint(compiled.evaluate(scope));
    } catch {
        return undefined;
    }
}

/** Try to evaluate a point expression with an empty scope (free-point test). */
function evalPointConst(exp: string): PointValue | undefined {
    try {
        const compiled = compileMath(convertTuplesToArrays(ggbToMathJs(exp)));
        return extractPoint(compiled.evaluate({ ...GGB_POW_SCOPE }));
    } catch {
        return undefined;
    }
}

/**
 * Parse a GeoGebra point list literal `{A', B, C}` into label strings.
 * Splits on top-level commas, strips braces and whitespace. Labels may
 * contain apostrophes (e.g. `A'`) and are distinct from `A`.
 */
function parsePointList(literal: string): string[] {
    let s = literal.trim();
    if (s.startsWith("{")) s = s.slice(1);
    if (s.endsWith("}")) s = s.slice(0, -1);
    return s
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
}
