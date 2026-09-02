/* Binding expressions to the values around them.
 *
 * A compiled expression reads its variables out of a flat slot array. This
 * class owns that array: it registers every parameter, keeps their current
 * values in the right slots, and hands back plain `(x) => number` closures with
 * the plot variable pre-wired. Everything downstream — the sampler, the
 * integrator, the ODE solver — then works with an ordinary function and knows
 * nothing about slots, parameters or the store.
 *
 * The frame is shared between every function this scope produces, which is
 * what makes evaluation allocation-free in the plotting loop. The cost is that
 * the closures are not re-entrant: two of them cannot be interleaved
 * mid-evaluation. Nothing in the app does that, and the alternative — a fresh
 * array per call — measurably slows down the one loop that matters.
 */

import {
  compileSource,
  ExpressionError,
  freeSymbols,
  parseExpression,
  SlotTable,
  type Evaluator,
  type UserFunction,
} from './compile';
import { FUNCTIONS } from './functions';

export interface CompiledFn0 {
  fn: () => number;
  error: string | null;
}
export interface CompiledFn1 {
  fn: (x: number) => number;
  error: string | null;
}
export interface CompiledFn2 {
  fn: (x: number, y: number) => number;
  error: string | null;
}

const FAILED_1: (x: number) => number = () => NaN;
const FAILED_2: (x: number, y: number) => number = () => NaN;

export class EvalScope {
  readonly slots = new SlotTable();
  readonly functions = new Map<string, UserFunction>();
  private frame: number[] = [];
  private readonly values = new Map<string, number>();

  constructor(initial: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(initial)) this.set(k, v);
  }

  set(name: string, value: number): void {
    this.values.set(name, value);
    const i = this.slots.slot(name);
    this.grow();
    this.frame[i] = value;
  }

  setAll(values: Record<string, number>): void {
    for (const [k, v] of Object.entries(values)) this.set(k, v);
  }

  /** Registers `name(params) = body`, so later expressions can call it. */
  defineFunction(source: string): string | null {
    const match = /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=\s*(.+)$/s.exec(source);
    if (!match) return 'A definition looks like f(x) = x^2 + 1';
    const [, name, paramText, bodyText] = match;
    if (name in FUNCTIONS) return `${name} is a built-in function and cannot be redefined`;
    const params = paramText
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (params.some((p) => !/^[A-Za-z_]\w*$/.test(p))) return 'Parameter names must be plain identifiers';
    try {
      const body = parseExpression(bodyText);
      // Free symbols inside a definition that are not its own parameters would
      // silently resolve against whatever is in the outer scope at call time,
      // which is a confusing kind of action at a distance. Only parameters and
      // named constants are allowed.
      const bound = new Set(params);
      const free = freeSymbols(body, bound).filter((s) => !(s in FUNCTIONS) && !this.values.has(s));
      if (free.length) {
        return `${name} refers to ${free.join(', ')}, which ${free.length === 1 ? 'is' : 'are'} not defined. Add ${free.length === 1 ? 'it' : 'them'} as a parameter or as an argument.`;
      }
      this.functions.set(name, { name, params, body });
      return null;
    } catch (err) {
      return err instanceof ExpressionError ? err.message : String(err);
    }
  }

  private grow(): void {
    while (this.frame.length < this.slots.names.length) this.frame.push(0);
  }

  /** Re-applies known values after a compile registered new slots. */
  private sync(): void {
    this.grow();
    for (const [k, v] of this.values) {
      const i = this.slots.indexOf(k);
      if (i !== undefined) this.frame[i] = v;
    }
  }

  private build(source: string): Evaluator {
    const ev = compileSource(source, { slots: this.slots, functions: this.functions });
    this.sync();
    return ev;
  }

  /** A constant expression, evaluated against the current parameter values. */
  compile0(source: string): CompiledFn0 {
    try {
      const ev = this.build(source);
      return { fn: () => ev(this.frame), error: null };
    } catch (err) {
      return { fn: () => NaN, error: messageOf(err) };
    }
  }

  compile1(source: string, variable: string): CompiledFn1 {
    try {
      const slot = this.slots.slot(variable);
      const ev = this.build(source);
      const frame = this.frame;
      return {
        fn: (x: number) => {
          frame[slot] = x;
          return ev(frame);
        },
        error: null,
      };
    } catch (err) {
      return { fn: FAILED_1, error: messageOf(err) };
    }
  }

  /**
   * A one-variable expression whose variable may be spelled several ways.
   *
   * The obvious alternative — compile against one name and fall back to
   * another if that fails — does not work, and failed silently for polar
   * curves. An unrecognised name is not a compile error here: it is given a
   * slot of its own, so `2(1 + cos(theta))` compiled against θ succeeds,
   * reads `theta` as zero, and plots a circle of radius 4 instead of a
   * cardioid. Writing the sample value into every accepted spelling removes
   * the possibility.
   */
  compileAliased(source: string, names: readonly string[]): CompiledFn1 {
    try {
      const slots = names.map((n) => this.slots.slot(n));
      const ev = this.build(source);
      const frame = this.frame;
      return {
        fn: (x: number) => {
          for (let i = 0; i < slots.length; i += 1) frame[slots[i]] = x;
          return ev(frame);
        },
        error: null,
      };
    } catch (err) {
      return { fn: FAILED_1, error: messageOf(err) };
    }
  }

  compile2(source: string, v1: string, v2: string): CompiledFn2 {
    try {
      const s1 = this.slots.slot(v1);
      const s2 = this.slots.slot(v2);
      const ev = this.build(source);
      const frame = this.frame;
      return {
        fn: (x: number, y: number) => {
          frame[s1] = x;
          frame[s2] = y;
          return ev(frame);
        },
        error: null,
      };
    } catch (err) {
      return { fn: FAILED_2, error: messageOf(err) };
    }
  }

  /** Free symbols an expression needs that this scope cannot supply. */
  unresolved(source: string): string[] {
    try {
      const node = parseExpression(source);
      return freeSymbols(node).filter((s) => !(s in FUNCTIONS) && !this.values.has(s));
    } catch {
      return [];
    }
  }

  /** Current value of a bound name, for readouts. */
  valueOf(name: string): number | undefined {
    return this.values.get(name);
  }
}

function messageOf(err: unknown): string {
  if (err instanceof ExpressionError) return err.detail ? `${err.message}: ${err.detail}` : err.message;
  return err instanceof Error ? err.message : String(err);
}
