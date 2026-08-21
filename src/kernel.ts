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
import { extractExpression, ggbToMathJs, compileMath, GGB_POW_SCOPE, evalGgbNum, compileToClosure, detectFunctionVar } from "./sampler";
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
    /** Ordered points (a Sequence-of-points use case). */
    points?: Array<{ x: number; y: number }>;
    /** Ordered scalars (a Sequence-of-numbers use case, e.g. Fourier
     * coefficients `a_n`, `b_n`). Mutually exclusive with `points`. */
    values?: number[];
}

/** Homogeneous line coefficients for `a·x + b·y + c = 0`. */
export interface LineValue {
    kind: "line";
    a: number;
    b: number;
    c: number;
}

export type ResolvedValue = NumberValue | PointValue | FunctionValue | ListValue | LineValue;

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
    | { kind: "derived-number"; exp: string }
    | { kind: "function-expr"; rhs: string; varName: string }
    | { kind: "fitpoly"; pointLabels: string[]; degree: number }
    | { kind: "sequence"; expr: string; varName: string; startExpr: string; endExpr: string; stepExpr?: string }
    | { kind: "line"; exp: string };

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
            // A numeric with a formula expression but no slider is a derived
            // scalar (e.g. the curvature radius `r = (1 + (0.8·a)²)^1.5 / 0.8`):
            // GeoGebra stores both the <expression> recipe and a <numeric>
            // snapshot of the last computed value. The snapshot goes stale the
            // moment a free input (`a`) changes, so evaluate the expression
            // live and let it track its inputs.
            if (!sl && expr?.exp && !expr.exp.trimStart().startsWith("\"")) {
                return { kind: "derived-number", exp: expr.exp };
            }
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

        // Line object: an explicit equation (`y = ε`, `x = 2`, `y = m x + b`).
        // GeoGebra stores a save-time snapshot of the homogeneous coefficients
        // in <element coords>, which goes stale the moment a free input (ε)
        // changes. Evaluate the equation live so a derived line tracks its
        // inputs, like a derived point does.
        if (el?.type === "line" || expr?.type === "line") {
            if (expr?.exp && expr.exp.includes("=")) {
                return { kind: "line", exp: expr.exp };
            }
            return undefined;
        }

        // Function defined directly by an expression f(x) = ...
        // Also treat an explicit conic written as `y = ...` (e.g. the parabola
        // `y = 0.4 * x^(2)`, stored as type="conic") as a function so that
        // point expressions like M = (a, f(a)) can evaluate f at a value.
        if (el?.type === "function" || expr?.type === "function"
            || (el?.type === "conic" && el.eqnStyle === "explicit")) {
            if (expr?.exp && expr.exp.includes("=")) {
                return { kind: "function-expr", rhs: extractExpression(expr.exp), varName: detectFunctionVar(expr.exp) };
            }
            return undefined; // produced by a command (e.g. FitPoly) or no expr
        }

        // Bare function-like expression without type (e.g. "h(x) = ...").
        // Skip string literals (text labels like `"圆心：A=(x ...)" + LaTeX[A]`)
        // — they contain "(" and "=" and would otherwise be misclassified as
        // functions, then fail to compile as mathjs and crash evaluation.
        if (expr?.exp && !expr.type && expr.exp.includes("(") && expr.exp.includes("=")
            && !expr.exp.trimStart().startsWith("\"")) {
            return { kind: "function-expr", rhs: extractExpression(expr.exp), varName: detectFunctionVar(expr.exp) };
        }

        // Derived scalar: a bare expression with no type that is neither a
        // point tuple nor a function (e.g. the curvature radius
        // `r = (1 + ((0.8 * a))^(2))^(1.5) / 0.8`, which references the slider
        // `a`). Evaluate it against the live scope so it tracks its inputs.
        if (expr?.exp && !expr.type && !expr.exp.trimStart().startsWith("\"")) {
            return { kind: "derived-number", exp: expr.exp };
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
            case "line":
                return evalLineExpr(recipe.exp, this.buildScope());
            case "derived-number": {
                // Use the structural evaluator so expressions referencing
                // higher-order commands (e.g. `a_0 = 1/T * Integral[...]`)
                // resolve; evalNumber only handles plain mathjs.
                const v = evalGgbNum(recipe.exp, this.buildScope());
                return Number.isFinite(v)
                    ? { kind: "number", value: v }
                    : undefined;
            }
            case "function-expr":
                return this.makeFunctionValue(recipe.rhs, recipe.varName);
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
                const values: number[] = [];
                let scalar = false;
                const dir = step > 0 ? 1 : -1;
                // Guard against runaway loops (e.g. huge end with tiny step).
                const maxIter = 100000;
                let v = start;
                let iter = 0;
                while (dir > 0 ? v <= end : v >= end) {
                    if (iter++ > maxIter) break;
                    const sub = { ...scope, [recipe.varName]: v };
                    // Prefer a scalar value (e.g. Fourier coefficients via
                    // Integral); fall back to a point tuple for point sequences.
                    const num = evalGgbNum(recipe.expr, sub);
                    if (Number.isFinite(num)) {
                        scalar = true;
                        values.push(num);
                    } else {
                        const pt = evalPointExpr(recipe.expr, sub);
                        if (pt) points.push({ x: pt.x, y: pt.y });
                    }
                    v += step;
                }
                return scalar
                    ? { kind: "list", values }
                    : { kind: "list", points };
            }
        }
    }

    /**
     * Build a function value whose evaluate closes over the current scope
     * (so a function referencing a slider/number re-reads it on each call).
     */
    private makeFunctionValue(rhs: string, varName: string = "x"): FunctionValue {
        // Snapshot the scope once per rebuild so slider-driven coefficients
        // (a_n, b_n, k) refresh on the next evaluate(). Prefer the closure
        // compiler: it parses the expression once per rebuild and yields a
        // tight evaluate-per-point closure, so a Fourier sum costs ~k
        // multiply-adds per sample point rather than k string recompiles
        // (which caused visible drag stutter). Falls back to evalGgbNum when
        // the structure isn't understood — correctness before speed.
        const scope = this.buildScope();
        const closure = compileToClosure(rhs, scope, varName);
        const compiled = (x: number): number => {
            try {
                if (closure) return closure(x);
                return evalGgbNum(rhs, { ...scope, [varName]: x });
            } catch {
                return NaN;
            }
        };
        return {
            kind: "function",
            evaluate: compiled,
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
                    // Scalar lists are referenced by `Element[list, i]`; expose
                    // them as plain arrays. Point lists are structural only.
                    if (value.values) scope[label] = value.values;
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
 * Evaluate a GeoGebra line equation against a scope, returning the
 * homogeneous coefficients of `a·x + b·y + c = 0`. Supports the explicit
 * forms GeoGebra writes for derived lines:
 *   `y = <rhs>`  → (0, 1, -rhs)        horizontal form (rhs may depend on ε)
 *   `x = <rhs>`  → (1, 0, -rhs)        vertical form
 * The rhs is evaluated live via the structural evaluator so a line like
 * `y = ε` tracks its driving slider. Returns undefined when the equation
 * cannot be parsed or the rhs does not resolve to a finite number.
 */
function evalLineExpr(exp: string, scope: Record<string, unknown>): LineValue | undefined {
    const eqIdx = exp.indexOf("=");
    if (eqIdx === -1) return undefined;
    const lhs = exp.slice(0, eqIdx).trim();
    const rhs = exp.slice(eqIdx + 1).trim();
    if (!rhs) return undefined;
    const k = evalGgbNum(rhs, scope);
    if (!Number.isFinite(k)) return undefined;
    // `y = ...` → 0·x + 1·y - k = 0 ; `x = ...` → 1·x + 0·y - k = 0.
    if (lhs === "y" || lhs === "Y") return { kind: "line", a: 0, b: 1, c: -k };
    if (lhs === "x" || lhs === "X") return { kind: "line", a: 1, b: 0, c: -k };
    return undefined;
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
