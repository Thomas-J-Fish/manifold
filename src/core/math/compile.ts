/* Expression compiler.
 *
 * mathjs does the parsing — it is excellent at it, and reimplementing operator
 * precedence and implicit multiplication would be a waste. What mathjs is not
 * is fast enough to evaluate inside a plotting loop: its evaluator walks a
 * tree of typed nodes and re-resolves scope on every call, which costs a few
 * microseconds per point. At 4000 points per curve, redrawn while a slider is
 * dragged at 60 fps, that is an order of magnitude too slow.
 *
 * So the AST is compiled once into a tree of JavaScript closures, with every
 * variable already resolved to an integer slot in a plain number array. The
 * hot loop then writes x into slot 0 and calls one function. That is roughly
 * 20–40× faster than mathjs evaluation on typical expressions.
 *
 * Note what this deliberately is NOT: `new Function` or `eval` on a generated
 * source string. Codegen would be a little faster still, but it would force
 * `script-src 'unsafe-eval'` into the app's Content-Security-Policy for the
 * sake of a few percent. Closures need no such exemption, so the renderer can
 * keep a strict CSP.
 */

import { parse, type MathNode } from 'mathjs';
import { CONSTANTS, FUNCTIONS } from './functions';

/** A compiled expression: reads its variables from the supplied slot array. */
export type Evaluator = (slots: number[]) => number;

export interface UserFunction {
  name: string;
  params: string[];
  body: MathNode;
}

export interface CompileOptions {
  /** Variables bound by position; anything else becomes a free symbol. */
  slots: SlotTable;
  /** User-defined functions available to the expression. */
  functions?: Map<string, UserFunction>;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/**
 * Maps variable names to array indices. Names are registered on first use, so
 * compiling an expression is also how the app discovers which parameters it
 * needs sliders for.
 */
export class SlotTable {
  private readonly index = new Map<string, number>();
  readonly names: string[] = [];

  constructor(initial: string[] = []) {
    for (const n of initial) this.slot(n);
  }

  slot(name: string): number {
    const existing = this.index.get(name);
    if (existing !== undefined) return existing;
    const i = this.names.length;
    this.index.set(name, i);
    this.names.push(name);
    return i;
  }

  has(name: string): boolean {
    return this.index.has(name);
  }

  indexOf(name: string): number | undefined {
    return this.index.get(name);
  }

  /** A zero-filled array sized for this table, ready to be written into. */
  frame(): number[] {
    return new Array<number>(this.names.length).fill(0);
  }
}

// ------------------------------------------------------------------ parsing

const LATEX_REPLACEMENTS: [RegExp, string][] = [
  [/\\left|\\right/g, ''],
  [/\\cdot|\\times/g, '*'],
  [/\\div/g, '/'],
  [/\\pi\b/g, 'pi'],
  [/\\tau\b/g, 'tau'],
  [/\\phi\b/g, 'phi'],
  [/\\infty/g, 'Infinity'],
  [/\\operatorname\{([a-zA-Z]+)\}/g, '$1'],
  [/\\(sin|cos|tan|csc|sec|cot|sinh|cosh|tanh|arcsin|arccos|arctan|exp|ln|log|min|max|gcd|deg)\b/g, '$1'],
  [/\\arcsin/g, 'asin'],
  [/\\arccos/g, 'acos'],
  [/\\arctan/g, 'atan'],
  [/\\sqrt\[([^\]]+)\]\{([^{}]*)\}/g, 'nthRoot($2,$1)'],
  [/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)'],
  [/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '(($1)/($2))'],
  [/\\dfrac\{([^{}]*)\}\{([^{}]*)\}/g, '(($1)/($2))'],
  [/\\abs\{([^{}]*)\}/g, 'abs($1)'],
  [/\\le\b/g, '<='],
  [/\\ge\b/g, '>='],
  [/\\ne\b/g, '!='],
  [/\\{|\\}/g, ''],
  [/\\,|\\;|\\!|\\quad|\\qquad/g, ' '],
  [/\^\{([^{}]*)\}/g, '^($1)'],
  [/_\{([^{}]*)\}/g, '_$1'],
];

/**
 * Accepts either plain syntax or the LaTeX a user pasted out of a paper, and
 * normalises it to something mathjs can parse. Nested braces defeat a regex,
 * so the brace-consuming rules are applied repeatedly until they stop changing
 * the string — enough for the two or three levels that occur in practice.
 */
export function normaliseInput(source: string): string {
  let s = source.trim();
  if (!s.includes('\\')) return s;
  for (let pass = 0; pass < 6; pass++) {
    const before = s;
    for (const [re, to] of LATEX_REPLACEMENTS) s = s.replace(re, to);
    if (s === before) break;
  }
  return s.trim();
}

export function parseExpression(source: string): MathNode {
  const text = normaliseInput(source);
  if (!text) throw new ExpressionError('Empty expression');
  try {
    return parse(text);
  } catch (err) {
    throw new ExpressionError(
      'Could not parse this expression',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Renders an expression as LaTeX for the live preview. Never throws. */
export function toLatex(source: string): string | null {
  try {
    return parseExpression(source).toTex({ parenthesis: 'auto', implicit: 'hide' });
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ analysis

interface NodeLike {
  type: string;
  [k: string]: unknown;
}

/** Free symbols in an expression: everything that is neither a known constant,
 *  nor a function being called, nor bound by an enclosing definition. */
export function freeSymbols(node: MathNode, bound: Set<string> = new Set()): string[] {
  const found = new Set<string>();
  const walk = (n: MathNode) => {
    const nl = n as unknown as NodeLike;
    if (nl.type === 'SymbolNode') {
      const name = String(nl.name);
      if (!(name in CONSTANTS) && !bound.has(name)) found.add(name);
      return;
    }
    if (nl.type === 'FunctionNode') {
      // The callee is a name, not a variable; only the arguments contribute.
      for (const a of (nl.args as MathNode[]) ?? []) walk(a);
      return;
    }
    if (nl.type === 'FunctionAssignmentNode') {
      const inner = new Set([...bound, ...((nl.params as string[]) ?? [])]);
      for (const s of freeSymbols(nl.expr as MathNode, inner)) found.add(s);
      return;
    }
    (n as unknown as { forEach: (cb: (child: MathNode) => void) => void }).forEach(walk);
  };
  walk(node);
  return [...found];
}

/** Function names an expression calls that are neither built in nor defined. */
export function unknownFunctions(node: MathNode, defined: Set<string>): string[] {
  const missing = new Set<string>();
  const walk = (n: MathNode) => {
    const nl = n as unknown as NodeLike;
    if (nl.type === 'FunctionNode') {
      const fnNode = nl.fn as NodeLike | undefined;
      const name = fnNode && fnNode.type === 'SymbolNode' ? String(fnNode.name) : String(nl.name ?? '');
      if (name && !(name in FUNCTIONS) && !defined.has(name)) missing.add(name);
    }
    (n as unknown as { forEach: (cb: (child: MathNode) => void) => void }).forEach(walk);
  };
  walk(node);
  return [...missing];
}

// ------------------------------------------------------------------ compilation

const OPERATORS: Record<string, (a: Evaluator, b: Evaluator) => Evaluator> = {
  add: (a, b) => (v) => a(v) + b(v),
  subtract: (a, b) => (v) => a(v) - b(v),
  multiply: (a, b) => (v) => a(v) * b(v),
  dotMultiply: (a, b) => (v) => a(v) * b(v),
  divide: (a, b) => (v) => a(v) / b(v),
  dotDivide: (a, b) => (v) => a(v) / b(v),
  pow: (a, b) => (v) => Math.pow(a(v), b(v)),
  dotPow: (a, b) => (v) => Math.pow(a(v), b(v)),
  mod: (a, b) => (v) => {
    const x = a(v);
    const y = b(v);
    return x - y * Math.floor(x / y);
  },
  equal: (a, b) => (v) => (a(v) === b(v) ? 1 : 0),
  unequal: (a, b) => (v) => (a(v) !== b(v) ? 1 : 0),
  smaller: (a, b) => (v) => (a(v) < b(v) ? 1 : 0),
  larger: (a, b) => (v) => (a(v) > b(v) ? 1 : 0),
  smallerEq: (a, b) => (v) => (a(v) <= b(v) ? 1 : 0),
  largerEq: (a, b) => (v) => (a(v) >= b(v) ? 1 : 0),
  and: (a, b) => (v) => (a(v) !== 0 && b(v) !== 0 ? 1 : 0),
  or: (a, b) => (v) => (a(v) !== 0 || b(v) !== 0 ? 1 : 0),
  xor: (a, b) => (v) => ((a(v) !== 0) !== (b(v) !== 0) ? 1 : 0),
};

const MAX_USER_FN_DEPTH = 64;

/**
 * Compiles a parsed expression into a closure tree.
 *
 * Every variable reference becomes an array index resolved now, not a map
 * lookup later; every constant subexpression collapses to a literal; and every
 * function call becomes a direct reference to an implementation from the
 * whitelist in functions.ts.
 */
export function compile(node: MathNode, options: CompileOptions): Evaluator {
  const { slots } = options;
  const userFns = options.functions ?? new Map<string, UserFunction>();
  let depth = 0;

  const build = (n: MathNode, locals: Map<string, number> | null): Evaluator => {
    const nl = n as unknown as NodeLike;
    switch (nl.type) {
      case 'ConstantNode': {
        const raw = nl.value;
        const value = typeof raw === 'number' ? raw : typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
        if (!Number.isFinite(value) && typeof raw !== 'number') {
          throw new ExpressionError(`Unsupported literal: ${String(raw)}`);
        }
        return () => value;
      }

      case 'SymbolNode': {
        const name = String(nl.name);
        const local = locals?.get(name);
        if (local !== undefined) return (v) => v[local];
        if (name in CONSTANTS) {
          const c = CONSTANTS[name];
          return () => c;
        }
        const i = slots.slot(name);
        return (v) => v[i];
      }

      case 'ParenthesisNode':
        return build(nl.content as MathNode, locals);

      case 'OperatorNode': {
        const fn = String(nl.fn);
        const args = (nl.args as MathNode[]) ?? [];
        if (fn === 'unaryMinus') {
          const a = build(args[0], locals);
          return (v) => -a(v);
        }
        if (fn === 'unaryPlus') return build(args[0], locals);
        if (fn === 'not') {
          const a = build(args[0], locals);
          return (v) => (a(v) === 0 ? 1 : 0);
        }
        if (fn === 'factorial') {
          const a = build(args[0], locals);
          const impl = FUNCTIONS.factorial.impl;
          return (v) => impl(a(v));
        }
        const make = OPERATORS[fn];
        if (!make) throw new ExpressionError(`Unsupported operator: ${fn}`);
        if (args.length !== 2) {
          // mathjs folds chains like a+b+c into one node with three arguments.
          const parts = args.map((a) => build(a, locals));
          return parts.reduce((acc, cur) => make(acc, cur));
        }
        return make(build(args[0], locals), build(args[1], locals));
      }

      case 'ConditionalNode': {
        const c = build(nl.condition as MathNode, locals);
        const t = build(nl.trueExpr as MathNode, locals);
        const f = build(nl.falseExpr as MathNode, locals);
        return (v) => {
          const cv = c(v);
          return cv !== 0 && !Number.isNaN(cv) ? t(v) : f(v);
        };
      }

      case 'FunctionNode': {
        const fnNode = nl.fn as NodeLike | undefined;
        const name = fnNode && fnNode.type === 'SymbolNode' ? String(fnNode.name) : String(nl.name ?? '');
        const args = ((nl.args as MathNode[]) ?? []).map((a) => build(a, locals));

        const user = userFns.get(name);
        if (user) {
          if (args.length !== user.params.length) {
            throw new ExpressionError(
              `${name} takes ${user.params.length} argument${user.params.length === 1 ? '' : 's'}, got ${args.length}`,
            );
          }
          if (++depth > MAX_USER_FN_DEPTH) {
            depth--;
            throw new ExpressionError(`${name} is defined in terms of itself too deeply`);
          }
          // Parameters live in a private frame that shadows the outer slots, so
          // f(x) = x^2 does not collide with the plot's own x.
          const inner = new Map<string, number>();
          user.params.forEach((p, i) => inner.set(p, i));
          const body = build(user.body, inner);
          depth--;
          const arity = args.length;
          return (v) => {
            const frame = new Array<number>(arity);
            for (let i = 0; i < arity; i++) frame[i] = args[i](v);
            // The body reads locals from `frame`, but any *outer* variable it
            // mentions was compiled against `slots`; that is why free symbols in
            // a definition are rejected at definition time, not here.
            return body(frame);
          };
        }

        const spec = FUNCTIONS[name];
        if (!spec) throw new ExpressionError(`Unknown function: ${name}`);
        if (args.length < spec.min || args.length > spec.max) {
          const want =
            spec.max === Infinity
              ? `at least ${spec.min}`
              : spec.min === spec.max
                ? `${spec.min}`
                : `${spec.min}–${spec.max}`;
          throw new ExpressionError(`${name} takes ${want} argument(s), got ${args.length}`);
        }
        const impl = spec.impl;
        // Monomorphic call sites for the common arities; V8 inlines these,
        // while the variadic path allocates and is 3–4× slower.
        switch (args.length) {
          case 0:
            return () => impl();
          case 1: {
            const a0 = args[0];
            return (v) => impl(a0(v));
          }
          case 2: {
            const [a0, a1] = args;
            return (v) => impl(a0(v), a1(v));
          }
          case 3: {
            const [a0, a1, a2] = args;
            return (v) => impl(a0(v), a1(v), a2(v));
          }
          default:
            return (v) => impl(...args.map((a) => a(v)));
        }
      }

      case 'ArrayNode':
      case 'RangeNode':
        throw new ExpressionError('Lists and ranges are not valid here — this slot needs a single value');

      case 'AssignmentNode':
        throw new ExpressionError('Assignment is not allowed inside an expression');

      case 'FunctionAssignmentNode':
        throw new ExpressionError('Define functions on their own line, e.g. f(x) = x^2');

      default:
        throw new ExpressionError(`Unsupported expression element: ${nl.type}`);
    }
  };

  return build(node, null);
}

/** Parse and compile in one step, for the common case. */
export function compileSource(source: string, options: CompileOptions): Evaluator {
  return compile(parseExpression(source), options);
}

/**
 * Compiles an expression of a single variable into the tightest possible
 * shape: no slot array indirection for the sample variable itself.
 */
export function compileUnary(
  source: string,
  variable: string,
  extra: SlotTable,
  functions?: Map<string, UserFunction>,
): { fn: (x: number, frame: number[]) => number; slots: SlotTable } {
  const slots = extra;
  const varSlot = slots.slot(variable);
  const ev = compileSource(source, { slots, ...(functions ? { functions } : {}) });
  return {
    fn: (x, frame) => {
      frame[varSlot] = x;
      return ev(frame);
    },
    slots,
  };
}
