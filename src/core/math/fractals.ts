/* Iterated maps: escape-time fractals, orbit diagrams, and cobweb plots.
 *
 * Every routine here is written to be resumable. A 1200×800 Mandelbrot at 800
 * iterations is around 400 million operations — far too much for one frame —
 * so the renderers take a row range and are driven by a scheduler that gives
 * them a few milliseconds at a time. The picture appears progressively and the
 * interface never stops responding, which also happens to look better than a
 * frozen window followed by a sudden image.
 */

export type FractalKind = 'mandelbrot' | 'julia' | 'burningship' | 'tricorn' | 'multibrot';

export interface FractalView {
  centreX: number;
  centreY: number;
  /** Half-width of the view in complex-plane units. */
  scale: number;
  width: number;
  height: number;
}

export interface FractalOptions {
  kind: FractalKind;
  maxIterations: number;
  /** Julia parameter c, and the exponent for multibrot. */
  juliaRe: number;
  juliaIm: number;
  power: number;
  /** Colour cycling period and offset, in iteration units. */
  colourPeriod: number;
  colourOffset: number;
  palette: PaletteId;
  /** Interior colouring: solid black, or shaded by orbit trap distance. */
  interior: 'black' | 'trap';
}

export type PaletteId = 'ultra' | 'ember' | 'ice' | 'spectral' | 'mono' | 'viridis';

/* Palettes are defined as a handful of anchor colours and interpolated, rather
 * than as 256-entry tables, so a smooth iteration count maps to a smooth
 * colour with no visible banding at deep zoom. */
const PALETTES: Record<PaletteId, [number, number, number][]> = {
  ultra: [
    [0, 7, 100],
    [32, 107, 203],
    [237, 255, 255],
    [255, 170, 0],
    [0, 2, 0],
  ],
  ember: [
    [10, 2, 20],
    [120, 20, 60],
    [232, 93, 4],
    [255, 214, 102],
    [255, 255, 240],
  ],
  ice: [
    [3, 8, 24],
    [12, 74, 110],
    [56, 189, 248],
    [224, 242, 254],
    [255, 255, 255],
  ],
  spectral: [
    [94, 79, 162],
    [50, 136, 189],
    [102, 194, 165],
    [254, 224, 139],
    [213, 62, 79],
  ],
  mono: [
    [8, 8, 10],
    [90, 90, 96],
    [180, 180, 190],
    [245, 245, 250],
    [120, 120, 130],
  ],
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
};

/** Cyclic linear interpolation through a palette's anchors. */
export function paletteColour(id: PaletteId, t: number): [number, number, number] {
  const anchors = PALETTES[id] ?? PALETTES.ultra;
  const n = anchors.length;
  const u = ((t % 1) + 1) % 1;
  const scaled = u * n;
  const i = Math.floor(scaled) % n;
  const j = (i + 1) % n;
  const f = scaled - Math.floor(scaled);
  const a = anchors[i];
  const b = anchors[j];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export const PALETTE_IDS: PaletteId[] = ['ultra', 'ember', 'ice', 'spectral', 'mono', 'viridis'];

/**
 * Renders rows [rowStart, rowEnd) of an escape-time fractal into `pixels`.
 *
 * The iteration count is smoothed by the standard renormalisation
 * ν = n + 1 − log₂(log|z|), which removes the concentric banding that plain
 * integer counts produce and is what makes deep zooms look continuous.
 */
export function renderFractalRows(
  pixels: Uint8ClampedArray,
  view: FractalView,
  opts: FractalOptions,
  rowStart: number,
  rowEnd: number,
): void {
  const { width, height } = view;
  const aspect = height / width;
  const xMin = view.centreX - view.scale;
  const xMax = view.centreX + view.scale;
  const yMin = view.centreY - view.scale * aspect;
  const yMax = view.centreY + view.scale * aspect;
  const dx = (xMax - xMin) / width;
  const dy = (yMax - yMin) / height;

  const maxIter = opts.maxIterations;
  // A generous escape radius is required for smooth colouring: the
  // renormalisation formula assumes |z| is already well past 2 when it stops.
  const bailout = 256;
  const bailout2 = bailout * bailout;
  const logBail = Math.log(Math.log(bailout));
  const ln2 = Math.LN2;
  const isJulia = opts.kind === 'julia';
  const power = Math.max(2, Math.round(opts.power));
  const generalPower = opts.kind === 'multibrot' && power !== 2;

  for (let py = rowStart; py < rowEnd; py++) {
    const y0 = yMax - py * dy;
    for (let px = 0; px < width; px++) {
      const x0 = xMin + px * dx;

      let zx: number;
      let zy: number;
      let cx: number;
      let cy: number;
      if (isJulia) {
        zx = x0;
        zy = y0;
        cx = opts.juliaRe;
        cy = opts.juliaIm;
      } else {
        zx = 0;
        zy = 0;
        cx = x0;
        cy = y0;
      }

      let n = 0;
      let zx2 = zx * zx;
      let zy2 = zy * zy;
      let trap = Infinity;

      if (!isJulia && opts.kind === 'mandelbrot') {
        // Cardioid and period-2 bulb tests. Most of the black area of the
        // classic set is inside one of these, and skipping the full iteration
        // there roughly halves the render time at default zoom.
        const q = (cx - 0.25) * (cx - 0.25) + cy * cy;
        if (q * (q + (cx - 0.25)) <= 0.25 * cy * cy || (cx + 1) * (cx + 1) + cy * cy <= 0.0625) {
          n = maxIter;
        }
      }

      while (n < maxIter && zx2 + zy2 <= bailout2) {
        if (generalPower) {
          const r = Math.pow(zx2 + zy2, power / 2);
          const theta = Math.atan2(zy, zx) * power;
          zx = r * Math.cos(theta) + cx;
          zy = r * Math.sin(theta) + cy;
        } else if (opts.kind === 'burningship') {
          const nx = zx2 - zy2 + cx;
          zy = Math.abs(2 * zx * zy) + cy;
          zx = nx;
        } else if (opts.kind === 'tricorn') {
          const nx = zx2 - zy2 + cx;
          zy = -2 * zx * zy + cy;
          zx = nx;
        } else {
          zy = 2 * zx * zy + cy;
          zx = zx2 - zy2 + cx;
        }
        zx2 = zx * zx;
        zy2 = zy * zy;
        const d = Math.abs(zx) + Math.abs(zy);
        if (d < trap) trap = d;
        n++;
      }

      const idx = (py * width + px) * 4;
      if (n >= maxIter) {
        if (opts.interior === 'trap') {
          const t = Math.min(1, trap * 1.4);
          const shade = Math.round(20 + t * 90);
          pixels[idx] = shade * 0.7;
          pixels[idx + 1] = shade * 0.75;
          pixels[idx + 2] = shade;
        } else {
          pixels[idx] = 6;
          pixels[idx + 1] = 8;
          pixels[idx + 2] = 14;
        }
        pixels[idx + 3] = 255;
        continue;
      }

      const modulus = Math.sqrt(zx2 + zy2);
      const nu = n + 1 - (Math.log(Math.log(modulus)) - logBail) / ln2;
      const t = (nu / Math.max(1, opts.colourPeriod) + opts.colourOffset) % 1;
      const [r, g, b] = paletteColour(opts.palette, t);
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
      pixels[idx + 3] = 255;
    }
  }
}

// ------------------------------------------------------------------ 1D maps

export interface MapSpec {
  id: string;
  name: string;
  latex: string;
  /** Sensible parameter range for the bifurcation sweep. */
  rMin: number;
  rMax: number;
  rDefault: number;
  x0: number;
  domain: [number, number];
  f: (x: number, r: number) => number;
}

export const MAPS: MapSpec[] = [
  {
    id: 'logistic',
    name: 'Logistic map',
    latex: 'x_{n+1} = r\\,x_n(1 - x_n)',
    rMin: 2.4,
    rMax: 4,
    rDefault: 3.7,
    x0: 0.4,
    domain: [0, 1],
    f: (x, r) => r * x * (1 - x),
  },
  {
    id: 'sine',
    name: 'Sine map',
    latex: 'x_{n+1} = r\\,\\sin(\\pi x_n)',
    rMin: 0.5,
    rMax: 1,
    rDefault: 0.9,
    x0: 0.4,
    domain: [0, 1],
    f: (x, r) => r * Math.sin(Math.PI * x),
  },
  {
    id: 'tent',
    name: 'Tent map',
    latex: 'x_{n+1} = r\\,\\min(x_n,\\,1-x_n)',
    rMin: 1,
    rMax: 2,
    rDefault: 1.9,
    x0: 0.3,
    domain: [0, 1],
    f: (x, r) => r * Math.min(x, 1 - x),
  },
  {
    id: 'cubic',
    name: 'Cubic map',
    latex: 'x_{n+1} = r\\,x_n(1 - x_n^2)',
    rMin: 1,
    rMax: 3.2,
    rDefault: 2.8,
    x0: 0.3,
    domain: [-1.5, 1.5],
    f: (x, r) => r * x * (1 - x * x),
  },
  {
    id: 'gauss',
    name: 'Gauss map',
    latex: 'x_{n+1} = e^{-6x_n^2} + r',
    rMin: -1,
    rMax: 1,
    rDefault: -0.5,
    x0: 0.1,
    domain: [-1, 1.2],
    f: (x, r) => Math.exp(-6 * x * x) + r,
  },
];

export const MAP_BY_ID = new Map(MAPS.map((m) => [m.id, m]));

/** The orbit of a single starting point, after discarding the transient. */
export function orbit(f: (x: number, r: number) => number, r: number, x0: number, transient: number, keep: number): Float64Array {
  let x = x0;
  for (let i = 0; i < transient; i++) {
    x = f(x, r);
    if (!Number.isFinite(x)) return new Float64Array(0);
  }
  const out = new Float64Array(keep);
  for (let i = 0; i < keep; i++) {
    x = f(x, r);
    out[i] = x;
  }
  return out;
}

/** The (x, y) pairs a cobweb diagram is drawn from: alternately step to the
 *  curve and to the diagonal. */
export function cobweb(
  f: (x: number, r: number) => number,
  r: number,
  x0: number,
  steps: number,
): Float64Array {
  const pts: number[] = [x0, 0];
  let x = x0;
  for (let i = 0; i < steps; i++) {
    const y = f(x, r);
    if (!Number.isFinite(y)) break;
    pts.push(x, y, y, y);
    x = y;
  }
  return Float64Array.from(pts);
}

export interface BifurcationOptions {
  map: (x: number, r: number) => number;
  rMin: number;
  rMax: number;
  columns: number;
  /** Iterations discarded before recording, to let the transient die out. */
  transient: number;
  /** Points recorded per column. */
  samples: number;
  x0: number;
  yMin: number;
  yMax: number;
  rows: number;
}

/**
 * Accumulates an orbit diagram into a density buffer, one column range at a
 * time. Counting hits per pixel rather than plotting points means the dense
 * bands of a chaotic regime read as bright rather than as saturated mush.
 */
export function bifurcationColumns(
  density: Float32Array,
  opts: BifurcationOptions,
  colStart: number,
  colEnd: number,
): number {
  let maxCount = 0;
  const dr = (opts.rMax - opts.rMin) / Math.max(1, opts.columns - 1);
  const spanY = opts.yMax - opts.yMin;
  for (let c = colStart; c < colEnd; c++) {
    const r = opts.rMin + c * dr;
    let x = opts.x0;
    let diverged = false;
    for (let i = 0; i < opts.transient; i++) {
      x = opts.map(x, r);
      if (!Number.isFinite(x)) {
        diverged = true;
        break;
      }
    }
    if (diverged) continue;
    for (let i = 0; i < opts.samples; i++) {
      x = opts.map(x, r);
      if (!Number.isFinite(x)) break;
      const row = Math.floor(((opts.yMax - x) / spanY) * opts.rows);
      if (row < 0 || row >= opts.rows) continue;
      const k = row * opts.columns + c;
      density[k] += 1;
      if (density[k] > maxCount) maxCount = density[k];
    }
  }
  return maxCount;
}

/**
 * The Lyapunov exponent of a 1D map: the average log of |f′|, which is
 * positive exactly when nearby orbits separate — the working definition of
 * chaos. Computed by finite differences so it works for any user-supplied map.
 */
export function lyapunovExponent(
  f: (x: number, r: number) => number,
  r: number,
  x0: number,
  transient = 500,
  iterations = 5000,
): number {
  let x = x0;
  for (let i = 0; i < transient; i++) {
    x = f(x, r);
    if (!Number.isFinite(x)) return NaN;
  }
  let sum = 0;
  let counted = 0;
  for (let i = 0; i < iterations; i++) {
    const h = 1e-7 * Math.max(Math.abs(x), 1e-4);
    const d = (f(x + h, r) - f(x - h, r)) / (2 * h);
    if (Number.isFinite(d) && Math.abs(d) > 1e-300) {
      sum += Math.log(Math.abs(d));
      counted++;
    }
    x = f(x, r);
    if (!Number.isFinite(x)) break;
  }
  return counted ? sum / counted : NaN;
}

/** Estimates the period of an orbit, or 0 if it looks aperiodic. */
export function detectPeriod(values: Float64Array, tolerance = 1e-6, maxPeriod = 64): number {
  const n = values.length;
  if (n < 4) return 0;
  for (let p = 1; p <= Math.min(maxPeriod, Math.floor(n / 3)); p++) {
    let ok = true;
    for (let i = n - 1; i >= n - 3 * p && i - p >= 0; i--) {
      if (Math.abs(values[i] - values[i - p]) > tolerance) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return 0;
}
