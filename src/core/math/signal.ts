/* Signal processing: spectra, spectrograms, filters and aliasing.
 *
 * The filters are designed the way filters are actually designed — an analogue
 * prototype whose poles are placed by a formula, mapped to the digital plane by
 * the bilinear transform, and factored into second-order sections. Not a
 * hand-tuned biquad with the coefficients written down. That matters because
 * the whole point of the mode is to show the *relationship* between where the
 * poles are and what the response looks like, and a filter whose poles were
 * chosen to make the response come out right teaches that backwards.
 */

import { fftInPlace, nextPowerOfTwo, windowFunction, coherentGain, type WindowName } from './fft';

// ---------------------------------------------------------------- spectra

export interface Spectrum {
  /** Bin centres in Hz, up to Nyquist. */
  frequency: Float64Array;
  /** Amplitude in the units of the signal, corrected for the window's gain. */
  magnitude: Float64Array;
  /** The same, in decibels relative to the largest component. */
  db: Float64Array;
  /** Phase in radians. */
  phase: Float64Array;
  /** Hz per bin — the resolution, which is 1/(the length of the recording). */
  resolution: number;
}

/**
 * The one-sided amplitude spectrum of a real signal.
 *
 * Scaled so a sine of amplitude A reads A at its own frequency: that means
 * dividing by N, doubling everything except DC and Nyquist because the other
 * half of the spectrum was folded onto it, and dividing by the window's mean
 * because the window took some of the signal away.
 */
export function spectrum(signal: ArrayLike<number>, sampleRate: number, window: WindowName = 'hann'): Spectrum {
  const n = Math.max(2, nextPowerOfTwo(signal.length));
  const w = windowFunction(window, signal.length);
  const gain = coherentGain(w);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < signal.length; i++) re[i] = signal[i] * w[i];
  fftInPlace(re, im, -1);

  const half = n / 2 + 1;
  const frequency = new Float64Array(half);
  const magnitude = new Float64Array(half);
  const db = new Float64Array(half);
  const phase = new Float64Array(half);
  const scale = 1 / (signal.length * Math.max(1e-12, gain));
  let peak = 1e-30;
  for (let i = 0; i < half; i++) {
    frequency[i] = (i * sampleRate) / n;
    const both = i > 0 && i < n / 2 ? 2 : 1;
    magnitude[i] = Math.hypot(re[i], im[i]) * scale * both;
    phase[i] = Math.atan2(im[i], re[i]);
    peak = Math.max(peak, magnitude[i]);
  }
  for (let i = 0; i < half; i++) db[i] = 20 * Math.log10(Math.max(1e-12, magnitude[i] / peak));
  return { frequency, magnitude, db, phase, resolution: sampleRate / n };
}

export interface Spectrogram {
  /** Frame *centre* times in seconds — the instant each column describes.
   *
   * A frame covers a whole window, and labelling it with the window's start
   * puts every feature half a window early: a chirp appears to begin before it
   * does, and the picture stops half a window short of the end of the signal
   * while the axis carries on. The centre is the only label under which a
   * frame's peak frequency is the signal's instantaneous frequency at that
   * time, which is the thing the view is for. */
  times: Float64Array;
  frequency: Float64Array;
  /** Row-major, one row per frame: db[frame * bins + bin]. */
  db: Float64Array;
  frames: number;
  bins: number;
  floor: number;
  /** Half a window, in seconds: how far each column extends either side of its
   * centre, and so how wide to draw it. */
  halfWindow: number;
}

/**
 * A short-time Fourier transform: how the spectrum changes as the signal goes on.
 *
 * The window length is the whole trade-off. A long window resolves frequency
 * finely and smears in time; a short one does the reverse, and no choice
 * escapes it — that is the uncertainty principle, in a place where it can be
 * seen rather than derived.
 */
export function spectrogram(
  signal: ArrayLike<number>,
  sampleRate: number,
  windowSize = 256,
  hop = Math.max(1, Math.floor(windowSize / 4)),
  window: WindowName = 'hann',
): Spectrogram {
  const size = nextPowerOfTwo(Math.max(16, windowSize));
  const w = windowFunction(window, size);
  const gain = coherentGain(w);
  const bins = size / 2 + 1;
  const frames = Math.max(1, Math.floor((signal.length - size) / hop) + 1);
  const db = new Float64Array(frames * bins);
  const times = new Float64Array(frames);
  const frequency = new Float64Array(bins);
  for (let i = 0; i < bins; i++) frequency[i] = (i * sampleRate) / size;

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let peak = 1e-30;
  for (let f = 0; f < frames; f++) {
    const start = f * hop;
    times[f] = (start + size / 2) / sampleRate;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < size; i++) {
      const at = start + i;
      re[i] = (at < signal.length ? signal[at] : 0) * w[i];
    }
    fftInPlace(re, im, -1);
    for (let i = 0; i < bins; i++) {
      const value = (Math.hypot(re[i], im[i]) * 2) / (size * Math.max(1e-12, gain));
      db[f * bins + i] = value;
      peak = Math.max(peak, value);
    }
  }
  for (let i = 0; i < db.length; i++) db[i] = 20 * Math.log10(Math.max(1e-10, db[i] / peak));
  return { times, frequency, db, frames, bins, floor: -90, halfWindow: size / 2 / sampleRate };
}

// ---------------------------------------------------------------- filters

export type FilterFamily = 'butterworth' | 'chebyshev';
export type FilterResponse = 'lowpass' | 'highpass' | 'bandpass' | 'notch';

export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface FilterSpec {
  family: FilterFamily;
  response: FilterResponse;
  order: number;
  /** Cutoff in Hz. For a band filter this is the lower edge. */
  cutoff: number;
  /** Upper edge in Hz, for band filters. */
  cutoffHigh: number;
  sampleRate: number;
  /** Passband ripple in dB, for Chebyshev. */
  ripple: number;
  /** Sharpness of a notch. */
  q: number;
}

export interface DesignedFilter {
  sections: Biquad[];
  poles: { re: number; im: number }[];
  zeros: { re: number; im: number }[];
  /** True when every pole is inside the unit circle. */
  stable: boolean;
  /** Largest pole magnitude — how close to unstable it is. */
  worstPole: number;
  description: string;
}

/** Poles of the normalised analogue prototype, as (ω₀, Q) pairs plus a real one. */
function prototype(family: FilterFamily, order: number, rippleDb: number): { pairs: { w0: number; q: number }[]; real: number | null } {
  const n = Math.max(1, Math.min(10, Math.round(order)));
  const pairs: { w0: number; q: number }[] = [];
  let real: number | null = null;

  if (family === 'chebyshev') {
    const epsilon = Math.sqrt(10 ** (Math.max(0.001, rippleDb) / 10) - 1);
    const v = Math.asinh(1 / epsilon) / n;
    for (let k = 0; k < Math.floor(n / 2); k++) {
      const theta = (Math.PI * (2 * k + 1)) / (2 * n);
      const sigma = -Math.sinh(v) * Math.sin(theta);
      const omega = Math.cosh(v) * Math.cos(theta);
      const w0 = Math.hypot(sigma, omega);
      pairs.push({ w0, q: w0 / (2 * Math.abs(sigma)) });
    }
    if (n % 2 === 1) real = Math.sinh(v);
  } else {
    for (let k = 0; k < Math.floor(n / 2); k++) {
      const theta = (Math.PI * (2 * k + 1)) / (2 * n);
      // Butterworth poles all sit on the unit circle, so ω₀ = 1 and only the
      // damping differs between pairs.
      pairs.push({ w0: 1, q: 1 / (2 * Math.sin(theta)) });
    }
    if (n % 2 === 1) real = 1;
  }
  return { pairs, real };
}

/* The prototype pole radius, warped for the band the section will occupy.
 *
 * A low-pass section is the prototype scaled by the cutoff: ω₀ → K·ω₀. A
 * high-pass is the prototype with s → 1/s *before* that scaling, which
 * reciprocates the radius as well: ω₀ → K/ω₀. For Butterworth the two are the
 * same number, because every prototype pole sits on the unit circle — which is
 * exactly why using K·ω₀ for both looks correct until someone asks for a
 * Chebyshev high-pass, whose poles do not, and gets a 30 dB resonance sitting
 * on the band edge. */
const warp = (k: number, w0: number, highpass: boolean): number => (highpass ? k / w0 : k * w0);

/** One second-order section, by the bilinear transform of an analogue pair. */
function biquadFromPair(w0: number, q: number, k: number, highpass: boolean): Biquad {
  const kk = warp(k, w0, highpass);
  const norm = 1 / (1 + kk / q + kk * kk);
  if (highpass) {
    return {
      b0: norm,
      b1: -2 * norm,
      b2: norm,
      a1: 2 * (kk * kk - 1) * norm,
      a2: (1 - kk / q + kk * kk) * norm,
    };
  }
  return {
    b0: kk * kk * norm,
    b1: 2 * kk * kk * norm,
    b2: kk * kk * norm,
    a1: 2 * (kk * kk - 1) * norm,
    a2: (1 - kk / q + kk * kk) * norm,
  };
}

function biquadFromReal(w0: number, k: number, highpass: boolean): Biquad {
  const kk = warp(k, w0, highpass);
  const norm = 1 / (kk + 1);
  return highpass
    ? { b0: norm, b1: -norm, b2: 0, a1: (kk - 1) * norm, a2: 0 }
    : { b0: kk * norm, b1: kk * norm, b2: 0, a1: (kk - 1) * norm, a2: 0 };
}

/**
 * Designs the filter.
 *
 * The cutoff is pre-warped with a tangent before the bilinear transform,
 * because that transform squashes the whole infinite analogue frequency axis
 * into the strip up to Nyquist and so moves every frequency except zero. Skip
 * the warp and the −3 dB point comes out low — by a per cent near DC and by a
 * factor of two near Nyquist, which is the kind of error that looks like a
 * rounding problem and is not.
 */
export function designFilter(spec: FilterSpec): DesignedFilter {
  const fs = Math.max(1e-6, spec.sampleRate);
  const nyquist = fs / 2;
  const clamp = (f: number) => Math.max(fs * 1e-5, Math.min(nyquist * 0.999, f));
  const sections: Biquad[] = [];

  if (spec.response === 'notch') {
    const f0 = clamp(spec.cutoff);
    const w = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w) / (2 * Math.max(0.05, spec.q));
    const norm = 1 / (1 + alpha);
    sections.push({
      b0: norm,
      b1: -2 * Math.cos(w) * norm,
      b2: norm,
      a1: -2 * Math.cos(w) * norm,
      a2: (1 - alpha) * norm,
    });
  } else {
    const build = (cutoff: number, highpass: boolean) => {
      const k = Math.tan((Math.PI * clamp(cutoff)) / fs);
      const { pairs, real } = prototype(spec.family, spec.order, spec.ripple);
      const first = sections.length;
      for (const p of pairs) sections.push(biquadFromPair(p.w0, p.q, k, highpass));
      if (real !== null) sections.push(biquadFromReal(real, k, highpass));

      /* An even-order Chebyshev does not pass DC at unity — it starts a whole
       * ripple down and rises to touch 0 dB at the peaks, which is what makes
       * the passband swing between 0 and −r rather than between +r and 0. Each
       * section here is built with unity gain at DC, so the cascade needs that
       * factor putting back. Odd orders already start at 0 dB and dip. */
      if (spec.family === 'chebyshev' && Math.round(spec.order) % 2 === 0) {
        const epsilon = Math.sqrt(10 ** (Math.max(0.001, spec.ripple) / 10) - 1);
        const scale = 1 / Math.sqrt(1 + epsilon * epsilon);
        const s0 = sections[first];
        s0.b0 *= scale;
        s0.b1 *= scale;
        s0.b2 *= scale;
      }
    };
    if (spec.response === 'lowpass') build(spec.cutoff, false);
    else if (spec.response === 'highpass') build(spec.cutoff, true);
    else {
      // A band-pass here is a high-pass and a low-pass in series, which is
      // exactly what a CR followed by an RC is. It is not a maximally-flat
      // band-pass of the same order, and saying so is better than pretending.
      build(Math.min(spec.cutoff, spec.cutoffHigh), true);
      build(Math.max(spec.cutoff, spec.cutoffHigh), false);
    }
  }

  const poles: { re: number; im: number }[] = [];
  const zeros: { re: number; im: number }[] = [];
  let worst = 0;
  for (const s of sections) {
    for (const root of quadraticRoots(1, s.a1, s.a2)) {
      poles.push(root);
      worst = Math.max(worst, Math.hypot(root.re, root.im));
    }
    for (const root of quadraticRoots(s.b0, s.b1, s.b2)) zeros.push(root);
  }

  const names: Record<FilterResponse, string> = {
    lowpass: 'Low pass',
    highpass: 'High pass',
    bandpass: 'Band pass',
    notch: 'Notch',
  };
  const family = spec.response === 'notch' ? 'second-order' : spec.family === 'chebyshev' ? `Chebyshev, ${spec.ripple} dB ripple` : 'Butterworth';
  return {
    sections,
    poles,
    zeros,
    stable: worst < 1,
    worstPole: worst,
    description: `${names[spec.response]}, ${family}`,
  };
}

/** Roots of az² + bz + c, real or complex, skipping degenerate orders. */
function quadraticRoots(a: number, b: number, c: number): { re: number; im: number }[] {
  if (Math.abs(a) < 1e-15) return Math.abs(b) < 1e-15 ? [] : [{ re: -c / b, im: 0 }];
  if (Math.abs(c) < 1e-15 && Math.abs(b) < 1e-15) return [];
  const disc = b * b - 4 * a * c;
  if (disc >= 0) {
    const root = Math.sqrt(disc);
    return [
      { re: (-b + root) / (2 * a), im: 0 },
      { re: (-b - root) / (2 * a), im: 0 },
    ];
  }
  const root = Math.sqrt(-disc);
  return [
    { re: -b / (2 * a), im: root / (2 * a) },
    { re: -b / (2 * a), im: -root / (2 * a) },
  ];
}

export interface Response {
  frequency: Float64Array;
  db: Float64Array;
  /** Unwrapped phase in degrees. */
  phase: Float64Array;
  /** In samples. */
  groupDelay: Float64Array;
}

/** H(e^{jω}) of the cascade, sampled from DC to Nyquist. */
export function frequencyResponse(filter: DesignedFilter, sampleRate: number, points = 512, logarithmic = true): Response {
  const nyquist = sampleRate / 2;
  const frequency = new Float64Array(points);
  const db = new Float64Array(points);
  const phase = new Float64Array(points);
  const groupDelay = new Float64Array(points);
  const lowest = Math.max(sampleRate * 1e-4, nyquist * 1e-4);

  const at = (f: number): { mag: number; arg: number } => {
    const w = (2 * Math.PI * f) / sampleRate;
    let re = 1;
    let im = 0;
    for (const s of filter.sections) {
      // Numerator and denominator at e^{-jω}, the usual way round for a
      // difference equation in delayed samples.
      const c1 = Math.cos(w);
      const s1 = Math.sin(w);
      const c2 = Math.cos(2 * w);
      const s2 = Math.sin(2 * w);
      const nRe = s.b0 + s.b1 * c1 + s.b2 * c2;
      const nIm = -(s.b1 * s1 + s.b2 * s2);
      const dRe = 1 + s.a1 * c1 + s.a2 * c2;
      const dIm = -(s.a1 * s1 + s.a2 * s2);
      const den = dRe * dRe + dIm * dIm || 1e-30;
      const hRe = (nRe * dRe + nIm * dIm) / den;
      const hIm = (nIm * dRe - nRe * dIm) / den;
      const outRe = re * hRe - im * hIm;
      im = re * hIm + im * hRe;
      re = outRe;
    }
    return { mag: Math.hypot(re, im), arg: Math.atan2(im, re) };
  };

  let unwrapped = 0;
  let previous = 0;
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const f = logarithmic ? lowest * (nyquist / lowest) ** t : t * nyquist;
    frequency[i] = f;
    const { mag, arg } = at(f);
    db[i] = 20 * Math.log10(Math.max(1e-12, mag));
    if (i === 0) {
      unwrapped = arg;
    } else {
      let step = arg - previous;
      while (step > Math.PI) step -= 2 * Math.PI;
      while (step < -Math.PI) step += 2 * Math.PI;
      unwrapped += step;
    }
    previous = arg;
    phase[i] = (unwrapped * 180) / Math.PI;
  }

  // Group delay as −dφ/dω, from the unwrapped phase.
  for (let i = 0; i < points; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(points - 1, i + 1);
    const dPhase = ((phase[b] - phase[a]) * Math.PI) / 180;
    const dOmega = ((frequency[b] - frequency[a]) * 2 * Math.PI) / sampleRate;
    groupDelay[i] = Math.abs(dOmega) < 1e-15 ? 0 : -dPhase / dOmega;
  }
  return { frequency, db, phase, groupDelay };
}

/** Runs a signal through the cascade, section by section. */
export function applyFilter(filter: DesignedFilter, signal: ArrayLike<number>): Float64Array {
  const out = Float64Array.from(signal as ArrayLike<number>);
  for (const s of filter.sections) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x = out[i];
      const y = s.b0 * x + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

// --------------------------------------------------------------- sampling

/**
 * Where a tone appears once it has been sampled too slowly.
 *
 * Everything above half the sampling rate is folded back down, and the folding
 * is exact: a 900 Hz tone sampled at 1000 Hz is indistinguishable from a
 * 100 Hz one, not approximately but *identically*, because the samples are the
 * same numbers. That is why the demonstration is worth having — there is no
 * cleverness that recovers the original.
 */
export function aliasFrequency(frequency: number, sampleRate: number): number {
  if (sampleRate <= 0) return frequency;
  const folded = Math.abs(frequency - sampleRate * Math.round(frequency / sampleRate));
  return folded;
}

/** True when the tone is sampled fast enough to be recovered. */
export const satisfiesNyquist = (frequency: number, sampleRate: number): boolean =>
  sampleRate > 2 * Math.abs(frequency);

/**
 * Reconstruct a continuous curve from samples by the sinc interpolation the
 * sampling theorem promises.
 *
 * Not a straight line between points — that would be a drawing choice. This is
 * the actual band-limited reconstruction, which is why the reconstructed wave
 * comes out at the *alias* frequency rather than the original: the theorem is
 * being obeyed exactly, and the information really has gone.
 */
export function sincReconstruct(
  samples: ArrayLike<number>,
  sampleRate: number,
  at: ArrayLike<number>,
): Float64Array {
  const out = new Float64Array(at.length);
  for (let i = 0; i < at.length; i++) {
    const t = at[i];
    let sum = 0;
    for (let k = 0; k < samples.length; k++) {
      const x = Math.PI * (t * sampleRate - k);
      sum += samples[k] * (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x);
    }
    out[i] = sum;
  }
  return out;
}
