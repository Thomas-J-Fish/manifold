import { describe, expect, it } from 'vitest';
import {
  aliasFrequency,
  applyFilter,
  designFilter,
  frequencyResponse,
  satisfiesNyquist,
  sincReconstruct,
  spectrogram,
  spectrum,
  type FilterSpec,
} from '../src/core/math/signal';

/* Filters have exact closed forms and it would be a waste not to use them. A
 * digital Butterworth made by the bilinear transform has magnitude
 *   |H(f)| = 1/√(1 + (tan(πf/fs)/tan(πfc/fs))^{2N}),
 * with the tangents there because the transform warps the frequency axis —
 * so this is a test of the design *and* of the pre-warping, which is the step
 * everybody forgets.
 */

const spec = (over: Partial<FilterSpec> = {}): FilterSpec => ({
  family: 'butterworth',
  response: 'lowpass',
  order: 4,
  cutoff: 1000,
  cutoffHigh: 4000,
  sampleRate: 48000,
  ripple: 1,
  q: 8,
  ...over,
});

function magnitudeAt(filter: ReturnType<typeof designFilter>, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs;
  let re = 1;
  let im = 0;
  for (const s of filter.sections) {
    const nRe = s.b0 + s.b1 * Math.cos(w) + s.b2 * Math.cos(2 * w);
    const nIm = -(s.b1 * Math.sin(w) + s.b2 * Math.sin(2 * w));
    const dRe = 1 + s.a1 * Math.cos(w) + s.a2 * Math.cos(2 * w);
    const dIm = -(s.a1 * Math.sin(w) + s.a2 * Math.sin(2 * w));
    const den = dRe * dRe + dIm * dIm;
    const hRe = (nRe * dRe + nIm * dIm) / den;
    const hIm = (nIm * dRe - nRe * dIm) / den;
    const outRe = re * hRe - im * hIm;
    im = re * hIm + im * hRe;
    re = outRe;
  }
  return Math.hypot(re, im);
}

describe('spectra', () => {
  it('reads back the amplitude and frequency of a tone', () => {
    const fs = 8000;
    const n = 4096;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) signal[i] = 1.7 * Math.sin((2 * Math.PI * 440 * i) / fs);
    const s = spectrum(signal, fs, 'hann');

    let peak = 0;
    let at = 0;
    for (let i = 0; i < s.magnitude.length; i++) {
      if (s.magnitude[i] > peak) {
        peak = s.magnitude[i];
        at = s.frequency[i];
      }
    }
    expect(at).toBeCloseTo(440, -1);
    /* 440 Hz at this length is 225.28 bins — between two of them — so a Hann
     * window reads about five per cent low. That is scalloping loss, not an
     * error: the peak of the true spectrum falls between the samples taken of
     * it. The flat-top window exists precisely to fix that, at the cost of
     * frequency resolution, and gets the height right to a per cent. */
    expect(peak).toBeGreaterThan(1.7 * 0.85);
    expect(peak).toBeLessThan(1.7);

    const flat = spectrum(signal, fs, 'flattop');
    let flatPeak = 0;
    for (const v of flat.magnitude) flatPeak = Math.max(flatPeak, v);
    expect(flatPeak).toBeCloseTo(1.7, 1);
    expect(s.resolution).toBeCloseTo(fs / 4096, 6);
  });

  it('separates two tones and puts them at the right relative level', () => {
    const fs = 8000;
    const n = 4096;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      signal[i] = Math.sin((2 * Math.PI * 500 * i) / fs) + 0.1 * Math.sin((2 * Math.PI * 1500 * i) / fs);
    }
    const s = spectrum(signal, fs, 'blackman');
    const near = (f: number) => {
      let best = 0;
      for (let i = 0; i < s.frequency.length; i++) {
        if (Math.abs(s.frequency[i] - f) < 20) best = Math.max(best, s.magnitude[i]);
      }
      return best;
    };
    expect(near(500)).toBeCloseTo(1, 1);
    // A tenth of the amplitude is 20 dB down, exactly.
    expect(20 * Math.log10(near(1500) / near(500))).toBeCloseTo(-20, 0);
  });

  it('follows a chirp up the spectrogram', () => {
    const fs = 8000;
    const n = 8192;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      // 200 Hz sweeping to 2000 Hz: instantaneous frequency 200 + 1800t/T.
      const phase = 2 * Math.PI * (200 * t + (900 * t * t) / (n / fs));
      signal[i] = Math.sin(phase);
    }
    const gram = spectrogram(signal, fs, 512);
    const peakOf = (frame: number) => {
      let best = -Infinity;
      let at = 0;
      for (let b = 0; b < gram.bins; b++) {
        const v = gram.db[frame * gram.bins + b];
        if (v > best) {
          best = v;
          at = gram.frequency[b];
        }
      }
      return at;
    };
    const first = peakOf(2);
    const last = peakOf(gram.frames - 3);
    expect(first).toBeGreaterThan(150);
    expect(first).toBeLessThan(450);
    expect(last).toBeGreaterThan(1500);
    // And monotonically in between, which a smeared or mis-indexed frame would
    // break even though the two ends looked right.
    let previous = -Infinity;
    for (let f = 2; f < gram.frames - 2; f += 3) {
      const now = peakOf(f);
      expect(now).toBeGreaterThan(previous - 120);
      previous = now;
    }
  });

  it('labels each frame with the instant it actually describes', () => {
    /* A frame covers a whole window, and the only label under which its peak
     * frequency equals the signal's instantaneous frequency is the window's
     * centre. Labelled by the window's *start* — as this once was — every
     * feature reads half a window early, and the picture stops half a window
     * short of the end of the recording with the axis running on past it.
     *
     * A tone that switches abruptly at a known instant is the way to catch
     * that: find where the spectrogram says the switch happened and compare. */
    const fs = 4000;
    const n = 8192;
    const switchAt = n / 2 / fs;
    const signal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      signal[i] = Math.sin(2 * Math.PI * (t < switchAt ? 200 : 900) * t);
    }
    const size = 512;
    const gram = spectrogram(signal, fs, size);
    expect(gram.halfWindow).toBeCloseTo(size / 2 / fs, 12);

    const peakOf = (frame: number) => {
      let best = -Infinity;
      let at = 0;
      for (let b = 0; b < gram.bins; b++) {
        const v = gram.db[frame * gram.bins + b];
        if (v > best) {
          best = v;
          at = gram.frequency[b];
        }
      }
      return at;
    };
    // The first frame whose peak has moved to the high tone: its centre must
    // be within one hop of the switch, not a whole window early.
    let crossed = -1;
    for (let f = 0; f < gram.frames; f++) {
      if (peakOf(f) > 550) {
        crossed = f;
        break;
      }
    }
    expect(crossed).toBeGreaterThan(0);
    const hop = size / 4 / fs;
    expect(Math.abs(gram.times[crossed] - switchAt)).toBeLessThan(2 * hop);

    // And the frames span the recording: half a window in from each end, and
    // no further, so the drawn image reaches both edges of the time axis.
    expect(gram.times[0]).toBeCloseTo(gram.halfWindow, 12);
    expect(gram.times[gram.frames - 1] + gram.halfWindow).toBeGreaterThan(n / fs - size / fs);
    expect(gram.times[gram.frames - 1] + gram.halfWindow).toBeLessThanOrEqual(n / fs + 1e-9);
  });
});

describe('filter design', () => {
  it('is exactly 3 dB down at its cutoff, at every order', () => {
    for (const order of [1, 2, 3, 4, 6, 8]) {
      const filter = designFilter(spec({ order }));
      const mag = magnitudeAt(filter, 1000, 48000);
      expect(20 * Math.log10(mag)).toBeCloseTo(-3.0103, 3);
    }
  });

  it('matches the Butterworth magnitude formula across the band', () => {
    const fs = 48000;
    const fc = 1000;
    for (const order of [2, 5]) {
      const filter = designFilter(spec({ order, cutoff: fc, sampleRate: fs }));
      for (const f of [50, 200, 700, 1000, 1500, 4000, 12000, 20000]) {
        const warp = Math.tan((Math.PI * f) / fs) / Math.tan((Math.PI * fc) / fs);
        const exact = 1 / Math.sqrt(1 + warp ** (2 * order));
        expect(magnitudeAt(filter, f, fs)).toBeCloseTo(exact, 6);
      }
    }
  });

  it('falls at 6n dB per octave well past the cutoff', () => {
    for (const order of [1, 2, 4]) {
      const filter = designFilter(spec({ order, cutoff: 200, sampleRate: 48000 }));
      const a = 20 * Math.log10(magnitudeAt(filter, 1600, 48000));
      const b = 20 * Math.log10(magnitudeAt(filter, 3200, 48000));
      expect(b - a).toBeCloseTo(-6.02 * order, 0);
    }
  });

  it('keeps every pole inside the unit circle', () => {
    for (const response of ['lowpass', 'highpass', 'bandpass', 'notch'] as const) {
      for (const family of ['butterworth', 'chebyshev'] as const) {
        const filter = designFilter(spec({ response, family, order: 6 }));
        expect(filter.stable).toBe(true);
        expect(filter.worstPole).toBeLessThan(1);
        for (const p of filter.poles) expect(Math.hypot(p.re, p.im)).toBeLessThan(1);
      }
    }
  });

  it('gives a Chebyshev exactly the ripple it was asked for', () => {
    const fs = 48000;
    const filter = designFilter(spec({ family: 'chebyshev', order: 6, cutoff: 2000, ripple: 1, sampleRate: fs }));
    let highest = 0;
    let lowest = Infinity;
    for (let f = 10; f < 1990; f += 5) {
      const db = 20 * Math.log10(magnitudeAt(filter, f, fs));
      highest = Math.max(highest, db);
      lowest = Math.min(lowest, db);
    }
    // Equiripple: the passband swings between 0 and −ripple and no further.
    expect(highest).toBeCloseTo(0, 2);
    expect(lowest).toBeCloseTo(-1, 1);
  });

  it('lands on the ripple edge at the cutoff whichever way round it is', () => {
    /* The high-pass is the low-pass with s → 1/s, which reciprocates each
     * prototype pole's radius as well as inverting the band. Butterworth poles
     * all have radius 1, so getting that wrong is invisible there and shows up
     * only as a Chebyshev high-pass with a large resonance parked on the band
     * edge — which is exactly what this once did, at order 4 and above. */
    const fs = 48000;
    const fc = 4000;
    for (const order of [1, 2, 3, 4, 5, 6, 8]) {
      for (const response of ['lowpass', 'highpass'] as const) {
        const chebyshev = designFilter(spec({ family: 'chebyshev', response, order, cutoff: fc, ripple: 1, sampleRate: fs }));
        const at = 20 * Math.log10(magnitudeAt(chebyshev, fc, fs));
        // A Chebyshev leaves its ripple band exactly at the cutoff, by
        // definition of the cutoff — at −1 dB here, not at −3.
        expect(`${response} n=${order}: ${at.toFixed(2)}`).toBe(`${response} n=${order}: -1.00`);

        // And nothing anywhere may exceed unity: a passive filter that
        // amplifies is the signature of a mis-transformed pole.
        let peak = -Infinity;
        for (let f = 5; f < fs / 2; f += 25) peak = Math.max(peak, 20 * Math.log10(magnitudeAt(chebyshev, f, fs)));
        expect(peak).toBeLessThan(0.01);

        // The Butterworth of the same shape is unaffected by any of this and
        // still meets its own −3 dB definition.
        const butter = designFilter(spec({ family: 'butterworth', response, order, cutoff: fc, sampleRate: fs }));
        expect(20 * Math.log10(magnitudeAt(butter, fc, fs))).toBeCloseTo(-3.0103, 3);
      }
    }
  });

  it('passes what it should and stops what it should, on a real signal', () => {
    const fs = 8000;
    const n = 4096;
    const low = new Float64Array(n);
    const high = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      low[i] = Math.sin((2 * Math.PI * 100 * i) / fs);
      high[i] = Math.sin((2 * Math.PI * 3000 * i) / fs);
    }
    const filter = designFilter(spec({ order: 4, cutoff: 500, sampleRate: fs }));
    const passed = applyFilter(filter, low);
    const stopped = applyFilter(filter, high);

    const rms = (a: Float64Array) => {
      let sum = 0;
      // Skip the start, where the filter is still filling up.
      for (let i = 500; i < a.length; i++) sum += a[i] * a[i];
      return Math.sqrt(sum / (a.length - 500));
    };
    expect(rms(passed)).toBeCloseTo(Math.SQRT1_2, 2);
    // Six octaves above cutoff at fourth order is a very long way down.
    expect(rms(stopped)).toBeLessThan(0.005);
    expect(20 * Math.log10(rms(stopped) / rms(passed))).toBeLessThan(-40);
  });

  it('puts a notch exactly on its frequency and nowhere else', () => {
    const fs = 8000;
    const filter = designFilter(spec({ response: 'notch', cutoff: 50, q: 20, sampleRate: fs }));
    expect(20 * Math.log10(magnitudeAt(filter, 50, fs))).toBeLessThan(-40);
    expect(magnitudeAt(filter, 10, fs)).toBeCloseTo(1, 1);
    expect(magnitudeAt(filter, 400, fs)).toBeCloseTo(1, 2);
  });

  it('reports a response whose numbers match the design', () => {
    const fs = 48000;
    const filter = designFilter(spec({ order: 3, cutoff: 1000, sampleRate: fs }));
    const response = frequencyResponse(filter, fs, 400);
    let closest = 0;
    for (let i = 1; i < response.frequency.length; i++) {
      if (Math.abs(response.frequency[i] - 1000) < Math.abs(response.frequency[closest] - 1000)) closest = i;
    }
    expect(response.db[closest]).toBeCloseTo(-3.01, 0);
    // A low-pass lags, so its phase runs negative and its group delay positive.
    expect(response.phase[response.phase.length - 1]).toBeLessThan(0);
    expect(response.groupDelay[0]).toBeGreaterThan(0);
  });

  it('makes a band pass out of a high pass and a low pass', () => {
    const fs = 48000;
    const filter = designFilter(spec({ response: 'bandpass', order: 2, cutoff: 500, cutoffHigh: 5000, sampleRate: fs }));
    expect(magnitudeAt(filter, 1500, fs)).toBeGreaterThan(0.9);
    expect(magnitudeAt(filter, 50, fs)).toBeLessThan(0.02);
    expect(magnitudeAt(filter, 20000, fs)).toBeLessThan(0.05);
    // Each edge is where it was asked for, 3 dB down from the middle.
    expect(20 * Math.log10(magnitudeAt(filter, 500, fs))).toBeCloseTo(-3.01, 1);
    expect(20 * Math.log10(magnitudeAt(filter, 5000, fs))).toBeCloseTo(-3.01, 1);
  });
});

describe('sampling and aliasing', () => {
  it('folds a tone back below Nyquist', () => {
    expect(aliasFrequency(900, 1000)).toBeCloseTo(100, 9);
    expect(aliasFrequency(1100, 1000)).toBeCloseTo(100, 9);
    expect(aliasFrequency(400, 1000)).toBeCloseTo(400, 9);
    expect(aliasFrequency(2050, 1000)).toBeCloseTo(50, 9);
    expect(satisfiesNyquist(400, 1000)).toBe(true);
    expect(satisfiesNyquist(600, 1000)).toBe(false);
  });

  it('makes the alias indistinguishable from the real thing, not merely similar', () => {
    /* The samples are *identical*, to rounding — which is the whole point.
     * No reconstruction can tell them apart because there is nothing to tell. */
    const fs = 1000;
    const original = new Float64Array(64);
    const alias = new Float64Array(64);
    for (let i = 0; i < 64; i++) {
      original[i] = Math.cos((2 * Math.PI * 900 * i) / fs);
      alias[i] = Math.cos((2 * Math.PI * 100 * i) / fs);
    }
    for (let i = 0; i < 64; i++) expect(original[i]).toBeCloseTo(alias[i], 12);
  });

  it('reconstructs the alias, because that is what the theorem gives back', () => {
    const fs = 1000;
    const n = 256;
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 900 * i) / fs);
    // Look in the middle, away from the ends where a finite sinc sum falls off.
    const at = Float64Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.0005);
    const rebuilt = sincReconstruct(samples, fs, at);
    for (let i = 0; i < at.length; i++) {
      // −100 Hz, since 900 Hz folds to the negative-frequency alias.
      expect(rebuilt[i]).toBeCloseTo(-Math.sin(2 * Math.PI * 100 * at[i]), 2);
    }
  });

  it('reconstructs faithfully when Nyquist is respected', () => {
    const fs = 1000;
    const n = 256;
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin((2 * Math.PI * 120 * i) / fs);
    const at = Float64Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.0005);
    const rebuilt = sincReconstruct(samples, fs, at);
    for (let i = 0; i < at.length; i++) {
      expect(rebuilt[i]).toBeCloseTo(Math.sin(2 * Math.PI * 120 * at[i]), 2);
    }
  });
});
