/* The function and constant vocabulary the expression language understands.
 *
 * This table is the security boundary as much as it is the feature list: the
 * compiler in compile.ts will only ever produce a call to something named
 * here, so a hostile-looking expression cannot reach anything outside it. Every
 * entry is a pure numeric function of numbers.
 */

import {
  betaFn,
  choose,
  erf,
  erfc,
  factorial,
  gammaFn,
  logGamma,
  normCdf,
  normPdf,
  permutations,
  invNormCdf,
} from './specfun';

export interface FnSpec {
  /** Minimum and maximum argument count; Infinity for variadic. */
  min: number;
  max: number;
  impl: (...args: number[]) => number;
  /** One-line description shown in the function palette. */
  doc: string;
  /** Grouping for the palette. */
  group: 'Arithmetic' | 'Trigonometry' | 'Exponential' | 'Rounding' | 'Statistics' | 'Logic' | 'Special';
  /** Rendered signature, e.g. `atan2(y, x)`. */
  sig: string;
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  'π': Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: 2 * Math.PI,
  'τ': 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2,
  'φ': (1 + Math.sqrt(5)) / 2,
  Infinity: Infinity,
  inf: Infinity,
  '∞': Infinity,
  NaN: NaN,
  nan: NaN,
  true: 1,
  false: 0,
  deg: Math.PI / 180,
};

function variadic(
  name: string,
  reduce: (acc: number, x: number) => number,
  seed: number,
  doc: string,
  group: FnSpec['group'],
): [string, FnSpec] {
  return [
    name,
    {
      min: 1,
      max: Infinity,
      doc,
      group,
      sig: `${name}(a, b, …)`,
      impl: (...a: number[]) => a.reduce(reduce, seed),
    },
  ];
}

export const FUNCTIONS: Record<string, FnSpec> = Object.fromEntries([
  // ---- trigonometry
  ['sin', { min: 1, max: 1, impl: Math.sin, doc: 'Sine (radians)', group: 'Trigonometry', sig: 'sin(x)' }],
  ['cos', { min: 1, max: 1, impl: Math.cos, doc: 'Cosine (radians)', group: 'Trigonometry', sig: 'cos(x)' }],
  ['tan', { min: 1, max: 1, impl: Math.tan, doc: 'Tangent (radians)', group: 'Trigonometry', sig: 'tan(x)' }],
  ['csc', { min: 1, max: 1, impl: (x: number) => 1 / Math.sin(x), doc: 'Cosecant', group: 'Trigonometry', sig: 'csc(x)' }],
  ['sec', { min: 1, max: 1, impl: (x: number) => 1 / Math.cos(x), doc: 'Secant', group: 'Trigonometry', sig: 'sec(x)' }],
  ['cot', { min: 1, max: 1, impl: (x: number) => 1 / Math.tan(x), doc: 'Cotangent', group: 'Trigonometry', sig: 'cot(x)' }],
  ['asin', { min: 1, max: 1, impl: Math.asin, doc: 'Inverse sine', group: 'Trigonometry', sig: 'asin(x)' }],
  ['acos', { min: 1, max: 1, impl: Math.acos, doc: 'Inverse cosine', group: 'Trigonometry', sig: 'acos(x)' }],
  ['atan', { min: 1, max: 1, impl: Math.atan, doc: 'Inverse tangent', group: 'Trigonometry', sig: 'atan(x)' }],
  ['atan2', { min: 2, max: 2, impl: Math.atan2, doc: 'Four-quadrant inverse tangent', group: 'Trigonometry', sig: 'atan2(y, x)' }],
  ['sinh', { min: 1, max: 1, impl: Math.sinh, doc: 'Hyperbolic sine', group: 'Trigonometry', sig: 'sinh(x)' }],
  ['cosh', { min: 1, max: 1, impl: Math.cosh, doc: 'Hyperbolic cosine', group: 'Trigonometry', sig: 'cosh(x)' }],
  ['tanh', { min: 1, max: 1, impl: Math.tanh, doc: 'Hyperbolic tangent', group: 'Trigonometry', sig: 'tanh(x)' }],
  ['asinh', { min: 1, max: 1, impl: Math.asinh, doc: 'Inverse hyperbolic sine', group: 'Trigonometry', sig: 'asinh(x)' }],
  ['acosh', { min: 1, max: 1, impl: Math.acosh, doc: 'Inverse hyperbolic cosine', group: 'Trigonometry', sig: 'acosh(x)' }],
  ['atanh', { min: 1, max: 1, impl: Math.atanh, doc: 'Inverse hyperbolic tangent', group: 'Trigonometry', sig: 'atanh(x)' }],

  // ---- exponential / power
  ['exp', { min: 1, max: 1, impl: Math.exp, doc: 'e raised to x', group: 'Exponential', sig: 'exp(x)' }],
  ['expm1', { min: 1, max: 1, impl: Math.expm1, doc: 'e^x − 1, accurate near 0', group: 'Exponential', sig: 'expm1(x)' }],
  ['ln', { min: 1, max: 1, impl: Math.log, doc: 'Natural logarithm', group: 'Exponential', sig: 'ln(x)' }],
  [
    'log',
    {
      min: 1,
      max: 2,
      impl: (x: number, b?: number) => (b === undefined ? Math.log(x) : Math.log(x) / Math.log(b)),
      doc: 'Logarithm; natural, or to a given base',
      group: 'Exponential',
      sig: 'log(x[, base])',
    },
  ],
  ['log2', { min: 1, max: 1, impl: Math.log2, doc: 'Base-2 logarithm', group: 'Exponential', sig: 'log2(x)' }],
  ['log10', { min: 1, max: 1, impl: Math.log10, doc: 'Base-10 logarithm', group: 'Exponential', sig: 'log10(x)' }],
  ['log1p', { min: 1, max: 1, impl: Math.log1p, doc: 'ln(1+x), accurate near 0', group: 'Exponential', sig: 'log1p(x)' }],
  ['sqrt', { min: 1, max: 1, impl: Math.sqrt, doc: 'Square root', group: 'Exponential', sig: 'sqrt(x)' }],
  ['cbrt', { min: 1, max: 1, impl: Math.cbrt, doc: 'Cube root', group: 'Exponential', sig: 'cbrt(x)' }],
  [
    'nthRoot',
    { min: 2, max: 2, impl: (x: number, n: number) => (x < 0 && n % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n)), doc: 'nth root, real branch for odd n', group: 'Exponential', sig: 'nthRoot(x, n)' },
  ],
  ['pow', { min: 2, max: 2, impl: Math.pow, doc: 'x raised to y', group: 'Exponential', sig: 'pow(x, y)' }],

  // ---- arithmetic
  ['abs', { min: 1, max: 1, impl: Math.abs, doc: 'Absolute value', group: 'Arithmetic', sig: 'abs(x)' }],
  ['sign', { min: 1, max: 1, impl: Math.sign, doc: '−1, 0 or 1', group: 'Arithmetic', sig: 'sign(x)' }],
  [
    'mod',
    { min: 2, max: 2, impl: (a: number, b: number) => a - b * Math.floor(a / b), doc: 'Floored modulo (result takes the sign of b)', group: 'Arithmetic', sig: 'mod(a, b)' },
  ],
  ['rem', { min: 2, max: 2, impl: (a: number, b: number) => a % b, doc: 'Truncated remainder', group: 'Arithmetic', sig: 'rem(a, b)' }],
  variadic('hypot', (acc, x) => Math.sqrt(acc * acc + x * x), 0, 'Euclidean norm of its arguments', 'Arithmetic'),
  variadic('min', (acc, x) => Math.min(acc, x), Infinity, 'Smallest argument', 'Arithmetic'),
  variadic('max', (acc, x) => Math.max(acc, x), -Infinity, 'Largest argument', 'Arithmetic'),
  variadic('sum', (acc, x) => acc + x, 0, 'Sum of its arguments', 'Arithmetic'),
  variadic('prod', (acc, x) => acc * x, 1, 'Product of its arguments', 'Arithmetic'),
  [
    'mean',
    { min: 1, max: Infinity, impl: (...a: number[]) => a.reduce((s, x) => s + x, 0) / a.length, doc: 'Arithmetic mean of its arguments', group: 'Statistics', sig: 'mean(a, b, …)' },
  ],
  ['clamp', { min: 3, max: 3, impl: clamp, doc: 'Constrain x to [lo, hi]', group: 'Arithmetic', sig: 'clamp(x, lo, hi)' }],
  [
    'lerp',
    { min: 3, max: 3, impl: (a: number, b: number, t: number) => a + (b - a) * t, doc: 'Linear interpolation from a to b', group: 'Arithmetic', sig: 'lerp(a, b, t)' },
  ],

  // ---- rounding
  ['floor', { min: 1, max: 1, impl: Math.floor, doc: 'Round down', group: 'Rounding', sig: 'floor(x)' }],
  ['ceil', { min: 1, max: 1, impl: Math.ceil, doc: 'Round up', group: 'Rounding', sig: 'ceil(x)' }],
  [
    'round',
    {
      min: 1,
      max: 2,
      impl: (x: number, d?: number) => {
        if (d === undefined) return Math.round(x);
        const f = Math.pow(10, d);
        return Math.round(x * f) / f;
      },
      doc: 'Round to nearest, optionally to d decimals',
      group: 'Rounding',
      sig: 'round(x[, d])',
    },
  ],
  ['trunc', { min: 1, max: 1, impl: Math.trunc, doc: 'Discard the fractional part', group: 'Rounding', sig: 'trunc(x)' }],
  ['fract', { min: 1, max: 1, impl: (x: number) => x - Math.floor(x), doc: 'Fractional part in [0,1)', group: 'Rounding', sig: 'fract(x)' }],

  // ---- logic / shaping
  ['step', { min: 1, max: 1, impl: (x: number) => (x >= 0 ? 1 : 0), doc: 'Heaviside step', group: 'Logic', sig: 'step(x)' }],
  [
    'rect',
    { min: 1, max: 1, impl: (x: number) => (Math.abs(x) <= 0.5 ? 1 : 0), doc: 'Unit rectangle on [−½, ½]', group: 'Logic', sig: 'rect(x)' },
  ],
  ['tri', { min: 1, max: 1, impl: (x: number) => Math.max(0, 1 - Math.abs(x)), doc: 'Unit triangle', group: 'Logic', sig: 'tri(x)' }],
  ['sinc', { min: 1, max: 1, impl: (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)), doc: 'Normalised cardinal sine', group: 'Logic', sig: 'sinc(x)' }],
  [
    'if',
    { min: 3, max: 3, impl: (c: number, a: number, b: number) => (c !== 0 && !Number.isNaN(c) ? a : b), doc: 'Conditional: if(cond, then, else)', group: 'Logic', sig: 'if(cond, a, b)' },
  ],
  [
    'smoothstep',
    {
      min: 3,
      max: 3,
      impl: (a: number, b: number, x: number) => {
        const t = clamp((x - a) / (b - a), 0, 1);
        return t * t * (3 - 2 * t);
      },
      doc: 'Smooth 0→1 ramp between a and b',
      group: 'Logic',
      sig: 'smoothstep(a, b, x)',
    },
  ],

  // ---- special / statistics
  ['gamma', { min: 1, max: 1, impl: gammaFn, doc: 'Gamma function Γ(x)', group: 'Special', sig: 'gamma(x)' }],
  ['lgamma', { min: 1, max: 1, impl: logGamma, doc: 'log Γ(x)', group: 'Special', sig: 'lgamma(x)' }],
  ['beta', { min: 2, max: 2, impl: betaFn, doc: 'Beta function B(a,b)', group: 'Special', sig: 'beta(a, b)' }],
  ['erf', { min: 1, max: 1, impl: erf, doc: 'Error function', group: 'Special', sig: 'erf(x)' }],
  ['erfc', { min: 1, max: 1, impl: erfc, doc: 'Complementary error function', group: 'Special', sig: 'erfc(x)' }],
  ['factorial', { min: 1, max: 1, impl: factorial, doc: 'n! (Γ(n+1) for non-integers)', group: 'Special', sig: 'factorial(n)' }],
  ['nCr', { min: 2, max: 2, impl: choose, doc: 'Binomial coefficient', group: 'Special', sig: 'nCr(n, k)' }],
  ['nPr', { min: 2, max: 2, impl: permutations, doc: 'Permutations', group: 'Special', sig: 'nPr(n, k)' }],
  [
    'normpdf',
    { min: 1, max: 3, impl: (x: number, m = 0, s = 1) => normPdf(x, m, s), doc: 'Normal density', group: 'Statistics', sig: 'normpdf(x[, μ, σ])' },
  ],
  [
    'normcdf',
    { min: 1, max: 3, impl: (x: number, m = 0, s = 1) => normCdf(x, m, s), doc: 'Normal cumulative probability', group: 'Statistics', sig: 'normcdf(x[, μ, σ])' },
  ],
  [
    'norminv',
    { min: 1, max: 3, impl: (p: number, m = 0, s = 1) => m + s * invNormCdf(p), doc: 'Normal quantile', group: 'Statistics', sig: 'norminv(p[, μ, σ])' },
  ],
]) as Record<string, FnSpec>;

/** Names that must not be used as variables because they already mean something. */
export const RESERVED = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);

export const FUNCTION_GROUPS = (() => {
  const groups = new Map<string, { name: string; spec: FnSpec }[]>();
  for (const [name, spec] of Object.entries(FUNCTIONS)) {
    const list = groups.get(spec.group) ?? [];
    list.push({ name, spec });
    groups.set(spec.group, list);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
})();
