/* The fast Fourier transform, and the windows you need to use it honestly.
 *
 * Written out rather than pulled in: the whole transform is fifty lines, it is
 * the single most-tested algorithm in numerical computing, and a dependency
 * here would be a megabyte of general-purpose signal library for one function.
 *
 * Iterative radix-2 with bit-reversal, in place, on separate real and
 * imaginary arrays. Separate arrays rather than interleaved because every
 * caller in this app already has real data and wants a magnitude back, and
 * interleaving would mean a copy in and a copy out of every call.
 */

/** The smallest power of two at least as large as n. */
export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

const isPowerOfTwo = (n: number): boolean => n > 0 && (n & (n - 1)) === 0;

/**
 * In-place complex FFT. `sign` is −1 for the forward transform.
 *
 * The inverse is the forward transform with the sign flipped and a 1/N at the
 * end, which is what `ifft` does — one implementation, so a bug cannot hide in
 * the direction nobody tests.
 */
export function fftInPlace(re: Float64Array, im: Float64Array, sign: -1 | 1 = -1): void {
  const n = re.length;
  if (n <= 1) return;
  if (!isPowerOfTwo(n)) throw new Error(`FFT length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        /* The twiddle is stepped by repeated multiplication rather than
         * recomputed with a cosine each time. For the lengths used here the
         * drift is a few ulps and it is twice as fast; anything longer than a
         * million points would want the recomputation back. */
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/** Forward transform of a real signal, zero-padded to a power of two. */
export function fftReal(signal: ArrayLike<number>, length = nextPowerOfTwo(signal.length)): {
  re: Float64Array;
  im: Float64Array;
} {
  const n = nextPowerOfTwo(length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < Math.min(signal.length, n); i++) re[i] = signal[i];
  fftInPlace(re, im, -1);
  return { re, im };
}

/** In-place inverse transform, including the 1/N. */
export function ifftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  fftInPlace(re, im, 1);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] /= n;
  }
}

export type WindowName = 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'flattop';

export const WINDOWS: { id: WindowName; label: string; hint: string }[] = [
  {
    id: 'rectangular',
    label: 'Rectangular',
    hint: 'No window at all. The narrowest main lobe and the worst leakage — fine for a signal that fits a whole number of cycles, misleading otherwise.',
  },
  {
    id: 'hann',
    label: 'Hann',
    hint: 'The usual choice. Sidelobes fall away quickly, at the cost of a main lobe twice as wide.',
  },
  { id: 'hamming', label: 'Hamming', hint: 'Lower first sidelobe than Hann, but the far ones decay more slowly.' },
  { id: 'blackman', label: 'Blackman', hint: 'Very low sidelobes, wider still. For separating a quiet tone from a loud one nearby.' },
  {
    id: 'flattop',
    label: 'Flat top',
    hint: 'Deliberately wide, so a peak lands at the right *height* even between bins. For measuring amplitude, not frequency.',
  },
];

/**
 * A window function, sampled over n points.
 *
 * Windowing is not optional decoration. The transform assumes the signal
 * repeats for ever, so unless a whole number of cycles fits exactly in the
 * buffer there is a discontinuity at the join, and that step smears energy
 * across every bin — the leakage that makes a clean sine look like a mountain
 * range. The window tapers the ends to zero so the join is smooth.
 */
export function windowFunction(name: WindowName, n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    switch (name) {
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
        break;
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * t);
        break;
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
        break;
      case 'flattop':
        w[i] =
          0.21557895 -
          0.41663158 * Math.cos(2 * Math.PI * t) +
          0.277263158 * Math.cos(4 * Math.PI * t) -
          0.083578947 * Math.cos(6 * Math.PI * t) +
          0.006947368 * Math.cos(8 * Math.PI * t);
        break;
      default:
        w[i] = 1;
        break;
    }
  }
  return w;
}

/** Mean of a window, which is what a windowed amplitude has to be divided by. */
export function coherentGain(w: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += w[i];
  return sum / Math.max(1, w.length);
}
