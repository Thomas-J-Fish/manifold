import { describe, expect, it } from 'vitest';
import { fftInPlace, ifftInPlace, nextPowerOfTwo, windowFunction, coherentGain } from '../src/core/math/fft';
import {
  MEDIUM_BY_ID,
  advanceWaveField,
  axisCrossings,
  createWaveField,
  criticalAngle,
  diffractionPattern,
  dispersedIndex,
  fraunhoferPattern,
  groupVelocity,
  lensmaker,
  modeFrequencies,
  reflectionCoefficient,
  thinLensImage,
  traceRays,
  traceSpectrum,
  type Slit,
  type Surface,
  type WaveWorld,
} from '../src/core/physics/waves';
import { makeTab } from '../src/core/defaults';

/* Three separate pieces of physics, each with textbook answers to be held to:
 * a wave equation that has to reflect by the right fraction at a join, a
 * diffraction integral that has to reproduce Fraunhofer in the far field while
 * being nothing like it in the near field, and rays that have to obey Snell
 * exactly enough to total-internally-reflect on their own.
 */

let counter = 0;
const slit = (centre: number, width: number, over: Partial<Slit> = {}): Slit => ({
  id: `s${counter++}`,
  centre,
  width,
  transmission: 1,
  phase: 0,
  ...over,
});

function world(over: Partial<WaveWorld> = {}): WaveWorld {
  return {
    view: 'propagate',
    medium: 'string',
    params: { tension: 40, density: 0.01 },
    length: 1,
    points: 600,
    left: 'fixed',
    right: 'fixed',
    junction: 0,
    speedRatio: 1,
    source: { kind: 'pulse', centre: 0.5, width: 0.03, frequency: 1, amplitude: 1 },
    duration: 0.02,
    wavelength: 550,
    slits: [slit(0, 0.1)],
    screenDistance: 2,
    screenWidth: 0.03,
    sourceDistance: 0,
    surfaces: [],
    rayCount: 9,
    rayHeight: 8,
    objectDistance: 0,
    rayAngle: 0,
    ...over,
  };
}

describe('the fast Fourier transform', () => {
  it('round-trips', () => {
    const n = 256;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.31) + 0.4 * Math.cos(i * 1.7);
      im[i] = 0.2 * Math.sin(i * 0.05);
    }
    const re0 = Float64Array.from(re);
    const im0 = Float64Array.from(im);
    fftInPlace(re, im, -1);
    ifftInPlace(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(re0[i], 10);
      expect(im[i]).toBeCloseTo(im0[i], 10);
    }
  });

  it('puts a pure tone in exactly one bin', () => {
    // Eight whole cycles in 64 samples: the tone lands on a bin centre, so a
    // correct transform puts everything there and nothing anywhere else.
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n);
    fftInPlace(re, im, -1);
    for (let bin = 0; bin < n / 2; bin++) {
      const magnitude = Math.hypot(re[bin], im[bin]);
      if (bin === 8) expect(magnitude).toBeCloseTo(n / 2, 8);
      else expect(magnitude).toBeLessThan(1e-9);
    }
  });

  it('obeys Parseval', () => {
    const n = 128;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.7) + 0.3 * i / n;
    let time = 0;
    for (let i = 0; i < n; i++) time += re[i] * re[i];
    fftInPlace(re, im, -1);
    let freq = 0;
    for (let i = 0; i < n; i++) freq += re[i] * re[i] + im[i] * im[i];
    expect(freq / n).toBeCloseTo(time, 8);
  });

  it('rounds lengths up to a power of two', () => {
    expect(nextPowerOfTwo(1)).toBe(1);
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(nextPowerOfTwo(1024)).toBe(1024);
    expect(() => fftInPlace(new Float64Array(3), new Float64Array(3))).toThrow();
  });

  it('gives each window the taper it is supposed to have', () => {
    for (const name of ['hann', 'blackman'] as const) {
      const w = windowFunction(name, 64);
      expect(w[0]).toBeCloseTo(0, 6);
      expect(w[63]).toBeCloseTo(0, 6);
      expect(Math.max(...w)).toBeGreaterThan(0.9);
    }
    // The flat top's coefficients take it slightly *below* zero at the ends —
    // that is the standard window, not a mistake to round away.
    const flat = windowFunction('flattop', 64);
    expect(Math.abs(flat[0])).toBeLessThan(1e-3);
    expect(flat[32]).toBeGreaterThan(0.9);
    const rect = windowFunction('rectangular', 32);
    expect(Math.min(...rect)).toBe(1);
    expect(coherentGain(rect)).toBeCloseTo(1, 12);
    // Hann's average is a half, which is the factor an amplitude has to be
    // corrected by after windowing.
    expect(coherentGain(windowFunction('hann', 4096))).toBeCloseTo(0.5, 3);
  });
});

describe('waves on a medium', () => {
  const speed = Math.sqrt(40 / 0.01); // 63.246 m/s

  it('carries a pulse at the speed the medium says', () => {
    const w = world({
      left: 'absorbing',
      right: 'absorbing',
      source: { kind: 'pulse', centre: 0.2, width: 0.02, frequency: 1, amplitude: 1 },
      duration: 0.008,
      length: 2,
      points: 1200,
    });
    const field = createWaveField(w);
    advanceWaveField(field, w.duration, 500000);

    const peakAt = (frame: number) => {
      let best = 0;
      let at = 0;
      for (let i = 0; i < field.n; i++) {
        const v = field.frames[frame * field.n + i];
        if (v > best) {
          best = v;
          at = field.x[i];
        }
      }
      return at;
    };
    // A standing pulse splits in two; the right-going half travels at v.
    const last = field.count - 1;
    const travelled = peakAt(last) - 0.4;
    expect(travelled / field.time[last]).toBeCloseTo(speed, -1);
  });

  it('reflects the right fraction at a change of speed, and inverts it going slower', () => {
    /* (c₂−c₁)/(c₂+c₁), which the integrator is never told. Into a medium half
     * the speed, a third of the amplitude comes back upside down. */
    const ratio = 0.5;
    const w = world({
      length: 2,
      points: 2000,
      left: 'absorbing',
      right: 'absorbing',
      junction: 0.5,
      speedRatio: ratio,
      source: { kind: 'pulse', centre: 0.25, width: 0.012, frequency: 1, amplitude: 1 },
      duration: 0.016,
    });
    const field = createWaveField(w);
    advanceWaveField(field, w.duration, 800000);

    const last = field.count - 1;
    let reflected = 0;
    for (let i = 0; i < field.n; i++) {
      if (field.x[i] >= 0.9) break;
      reflected = Math.min(reflected, field.frames[last * field.n + i]);
    }
    const expected = reflectionCoefficient(1, ratio) * 0.5; // half the split pulse
    expect(reflected).toBeLessThan(0);
    expect(reflected / expected).toBeCloseTo(1, 0);
  });

  it('turns a pulse upside down at a fixed end and not at a free one', () => {
    const run = (end: 'fixed' | 'free') => {
      const w = world({
        length: 1,
        points: 1200,
        left: 'absorbing',
        right: end,
        source: { kind: 'pulse', centre: 0.6, width: 0.02, frequency: 1, amplitude: 1 },
        duration: 0.02,
      });
      const field = createWaveField(w);
      advanceWaveField(field, w.duration, 500000);
      const last = field.count - 1;
      let extreme = 0;
      for (let i = 0; i < field.n; i++) {
        const v = field.frames[last * field.n + i];
        if (Math.abs(v) > Math.abs(extreme)) extreme = v;
      }
      return extreme;
    };
    expect(run('fixed')).toBeLessThan(0);
    expect(run('free')).toBeGreaterThan(0);
  });

  it('holds a normal mode still in shape', () => {
    // The third mode of a fixed–fixed string should oscillate in place, so its
    // nodes stay put for ever. Anything that drifts is the scheme, not physics.
    const w = world({
      source: { kind: 'mode', centre: 0.5, width: 0.1, frequency: 3, amplitude: 1 },
      duration: 0.05,
      points: 900,
    });
    const field = createWaveField(w);
    advanceWaveField(field, w.duration, 500000);
    const last = field.count - 1;
    // The node at a third of the way along.
    const nodeIndex = Math.round((field.n - 1) / 3);
    for (let f = 0; f < field.count; f += 20) {
      expect(Math.abs(field.frames[f * field.n + nodeIndex])).toBeLessThan(0.02);
    }
    expect(Math.abs(field.frames[last * field.n + nodeIndex])).toBeLessThan(0.02);
  });

  it('conserves energy between fixed ends and loses it to an absorbing one', () => {
    const closed = createWaveField(world({ duration: 0.03, left: 'fixed', right: 'fixed' }));
    advanceWaveField(closed, 0.03, 500000);
    for (let f = 1; f < closed.count; f++) {
      expect(closed.energy[f] / closed.energy[0]).toBeCloseTo(1, 1);
    }

    const open = createWaveField(world({ duration: 0.05, left: 'absorbing', right: 'absorbing' }));
    advanceWaveField(open, 0.05, 500000);
    expect(open.energy[open.count - 1]).toBeLessThan(open.energy[0] * 0.1);
  });

  it('names the harmonics each pair of ends allows', () => {
    const v = 100;
    expect(modeFrequencies(v, 2, 'fixed', 'fixed', 3)).toEqual([25, 50, 75]);
    expect(modeFrequencies(v, 2, 'free', 'free', 3)).toEqual([25, 50, 75]);
    // One end of each: only the odd harmonics of v/4L, the clarinet's problem.
    expect(modeFrequencies(v, 2, 'fixed', 'free', 3)).toEqual([12.5, 37.5, 62.5]);
    expect(modeFrequencies(v, 2, 'free', 'fixed', 3)).toEqual([12.5, 37.5, 62.5]);
  });

  it('allows no modes at all when an end absorbs', () => {
    /* A standing wave is a travelling one interfering with its own
     * reflection. An end that reflects nothing gives no reflection and so no
     * resonance at any frequency — not the fixed–free ladder, which is what
     * came back when 'absorbing' merely failed the "both ends the same" test. */
    for (const pair of [
      ['absorbing', 'absorbing'],
      ['absorbing', 'fixed'],
      ['free', 'absorbing'],
    ] as const) {
      expect(`${pair}: ${modeFrequencies(100, 2, pair[0], pair[1], 4).length}`).toBe(`${pair}: 0`);
    }
  });
});

describe('dispersion', () => {
  it('has water waves spread and a string not', () => {
    const string = MEDIUM_BY_ID.get('string')!;
    const water = MEDIUM_BY_ID.get('water')!;
    const p = { tension: 40, density: 0.01 };
    const wp = { depth: 2 };
    // Non-dispersive: group velocity equals phase velocity at every k.
    for (const k of [1, 10, 100]) {
      expect(groupVelocity(string, k, p) / (string.omega(k, p) / k)).toBeCloseTo(1, 6);
    }
    // Deep water: group velocity is half the phase velocity, the classic result.
    const k = 50; // kh = 100, thoroughly deep
    expect(groupVelocity(water, k, wp) / (water.omega(k, wp) / k)).toBeCloseTo(0.5, 3);
    /* Shallow water is non-dispersive again, at √(gh) — but only in the limit.
     * At kh = 0.1 it is already 0.17% slow, because tanh(x)/x = 1 − x²/3, and
     * asserting the limit at a finite kh would be asserting the approximation
     * rather than the physics. */
    const shallow = 0.005; // kh = 0.01, so tanh costs 1.7 parts in 10⁵
    expect(water.omega(shallow, wp) / shallow).toBeCloseTo(Math.sqrt(9.80665 * 2), 3);
  });

  it('gives the mass–spring chain a cutoff frequency', () => {
    const chain = MEDIUM_BY_ID.get('spring')!;
    const p = { stiffness: 200, mass: 0.02, spacing: 0.02 };
    const max = 2 * Math.sqrt(p.stiffness / p.mass);
    // At the zone boundary the chain is at its ceiling and cannot go higher.
    expect(chain.omega(Math.PI / p.spacing, p)).toBeCloseTo(max, 6);
    for (const k of [1, 50, 100, 157, 300]) expect(chain.omega(k, p)).toBeLessThanOrEqual(max + 1e-9);
    // And the group velocity falls to zero there: the wave stops travelling.
    expect(Math.abs(groupVelocity(chain, Math.PI / p.spacing, p))).toBeLessThan(1);
  });
});

describe('diffraction', () => {
  it('reproduces the single-slit pattern in the far field', () => {
    const w = world({
      view: 'diffract',
      wavelength: 550,
      slits: [slit(0, 0.08)],
      screenDistance: 4,
      screenWidth: 0.14,
    });
    const result = diffractionPattern(w, 700);
    for (let i = 0; i < result.x.length; i += 7) {
      const analytic = fraunhoferPattern(result.angle[i], 550, 0.08, 0, 1);
      expect(Math.abs(result.intensity[i] - analytic)).toBeLessThan(0.03);
    }
    // And the first zero is where λ/a says.
    expect(result.firstMinimum).toBeCloseTo(Math.asin(550e-9 / 0.08e-3), 6);
  });

  it('reproduces two-slit fringes, envelope and all', () => {
    const w = world({
      view: 'diffract',
      wavelength: 633,
      slits: [slit(-0.1, 0.04), slit(0.1, 0.04)],
      screenDistance: 3,
      screenWidth: 0.05,
    });
    const result = diffractionPattern(w, 900);
    for (let i = 0; i < result.x.length; i += 9) {
      const analytic = fraunhoferPattern(result.angle[i], 633, 0.04, 0.2, 2);
      expect(Math.abs(result.intensity[i] - analytic)).toBeLessThan(0.05);
    }
    // Fringe spacing λD/d, which for these numbers is about 9.5 mm.
    expect(result.fringeSpacing).toBeCloseTo((633e-9 * 3) / 0.2e-3, 6);
  });

  it('sharpens the maxima as slits are added', () => {
    const widthOfPeak = (count: number) => {
      const slits = Array.from({ length: count }, (_, i) => slit((i - (count - 1) / 2) * 0.15, 0.03));
      const result = diffractionPattern(
        world({ view: 'diffract', wavelength: 550, slits, screenDistance: 3, screenWidth: 0.02 }),
        1200,
      );
      // Full width at half maximum of the central peak, in samples.
      let wide = 0;
      for (let i = 0; i < result.intensity.length; i++) if (result.intensity[i] > 0.5) wide++;
      return wide;
    };
    const two = widthOfPeak(2);
    const eight = widthOfPeak(8);
    // A diffraction grating's whole purpose: more slits, sharper lines.
    expect(eight).toBeLessThan(two / 2);
  });

  it('is not the Fraunhofer formula in the near field', () => {
    /* The point of integrating rather than looking up. Close to a wide slit the
     * pattern is a shadow with ripples at its edges, nothing like a sinc². */
    const near = world({
      view: 'diffract',
      wavelength: 550,
      slits: [slit(0, 2)],
      screenDistance: 0.05,
      screenWidth: 0.003,
    });
    const result = diffractionPattern(near, 600);
    expect(result.fresnelNumber).toBeGreaterThan(10);
    let worst = 0;
    for (let i = 0; i < result.x.length; i += 5) {
      const analytic = fraunhoferPattern(result.angle[i], 550, 2, 0, 1);
      worst = Math.max(worst, Math.abs(result.intensity[i] - analytic));
    }
    expect(worst).toBeGreaterThan(0.3);
    // The middle is illuminated, roughly uniformly — a geometric shadow.
    const middle = result.intensity[Math.floor(result.x.length / 2)];
    expect(middle).toBeGreaterThan(0.3);
  });

  it('handles an aperture no formula covers', () => {
    // Two slits of different widths with half a wavelength of glass over one:
    // the fringes are still there but the centre is now a minimum.
    const w = world({
      view: 'diffract',
      wavelength: 550,
      slits: [slit(-0.15, 0.05), slit(0.15, 0.05, { phase: Math.PI })],
      screenDistance: 3,
      screenWidth: 0.03,
    });
    const result = diffractionPattern(w, 801);
    const centre = result.intensity[400];
    expect(centre).toBeLessThan(0.02);
    expect(Math.max(...result.intensity)).toBeCloseTo(1, 6);
  });
});

describe('rays', () => {
  const glass = (z: number, radius: number, index: number, aperture = 12): Surface => ({
    id: `s${counter++}`,
    z,
    radius,
    tilt: 0,
    aperture,
    index,
    mirror: false,
    label: '',
  });

  it('brings parallel rays to the focus the lensmaker predicts', () => {
    // A thin biconvex lens: R₁ = +60, R₂ = −60, n = 1.5 gives f = 60 mm.
    const f = lensmaker(1.5, 60, -60);
    expect(f).toBeCloseTo(60, 6);

    const w = world({
      view: 'rays',
      surfaces: [glass(0, 60, 1.5), glass(1, -60, 1)],
      rayCount: 5,
      rayHeight: 3,
      objectDistance: 0,
    });
    const crossings = axisCrossings(traceRays(w));
    expect(crossings.length).toBeGreaterThan(3);
    const mean = crossings.reduce((a, b) => a + b, 0) / crossings.length;
    // Within a couple of per cent of the thin-lens answer, the difference
    // being the thickness and the aberration this trace does not hide.
    expect(mean / f).toBeCloseTo(1, 1);
  });

  it('shows spherical aberration rather than assuming it away', () => {
    const w = world({
      view: 'rays',
      // Ten millimetres thick: two R = 60 surfaces one millimetre apart would
      // intersect each other well before a ray height of 22, and the lens
      // would not be a solid object at all.
      surfaces: [glass(0, 60, 1.5, 30), glass(10, -60, 1, 30)],
      rayCount: 11,
      rayHeight: 22,
      objectDistance: 0,
    });
    const rays = traceRays(w);
    const crossings = axisCrossings(rays);
    expect(crossings.length).toBeGreaterThan(6);
    const spread = Math.max(...crossings) - Math.min(...crossings);
    /* A paraxial model gives every ray the same focus and a spread of exactly
     * zero. A real spherical surface does not, and the marginal rays come to a
     * focus *nearer* the lens — the sign matters, and getting it backwards
     * would be a plausible-looking bug. */
    expect(spread).toBeGreaterThan(1);
    const marginal = Math.min(...crossings);
    const paraxial = Math.max(...crossings);
    expect(marginal).toBeLessThan(paraxial);
  });

  it('obeys the thin-lens equation for an object at a finite distance', () => {
    const f = 60;
    const u = 180;
    const v = thinLensImage(f, u);
    expect(v).toBeCloseTo(90, 6);

    const w = world({
      view: 'rays',
      surfaces: [glass(0, 60, 1.5, 20), glass(1, -60, 1, 20)],
      rayCount: 7,
      rayHeight: 6,
      objectDistance: u,
    });
    const crossings = axisCrossings(traceRays(w)).filter((z) => z > 5);
    const mean = crossings.reduce((a, b) => a + b, 0) / crossings.length;
    expect(mean / v).toBeCloseTo(1, 0);
  });

  it('totally internally reflects exactly past the critical angle', () => {
    const critical = criticalAngle(1.5, 1)!;
    expect(critical).toBeCloseTo(41.81, 1);
    expect(criticalAngle(1, 1.5)).toBeNull();

    /* A block of glass whose exit face is tilted. Light enters along the axis,
     * so it meets that face at exactly the tilt angle, and whether it gets out
     * is decided by Snell having a solution or not — nothing in the tracer
     * knows what a critical angle is. */
    const exits = (tilt: number) => {
      const w = world({
        view: 'rays',
        surfaces: [
          { id: 'in', z: 0, radius: 0, tilt: 0, aperture: 80, index: 1.5, mirror: false, label: '' },
          { id: 'out', z: 40, radius: 0, tilt, aperture: 80, index: 1, mirror: false, label: '' },
        ],
        rayCount: 1,
        rayHeight: 0,
        objectDistance: 0,
        rayAngle: 0,
      });
      return !traceRays(w)[0].totalInternal;
    };

    expect(exits(20)).toBe(true);
    expect(exits(41)).toBe(true);
    expect(exits(43)).toBe(false);
    // A 45° face turns the beam through a right angle and loses nothing: the
    // prism in every pair of binoculars, and the reason they use one instead
    // of a mirror.
    expect(exits(45)).toBe(false);

    // Find the changeover by bisection and check it is the critical angle.
    let lo = 20;
    let hi = 60;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (exits(mid)) lo = mid;
      else hi = mid;
    }
    expect((lo + hi) / 2).toBeCloseTo(critical, 4);
  });

  it('bends light towards the normal entering glass, by exactly Snell', () => {
    const w = world({
      view: 'rays',
      surfaces: [{ id: 'flat', z: 0, radius: 0, tilt: 0, aperture: 100, index: 1.5, mirror: false, label: '' }],
      rayCount: 1,
      rayHeight: 0,
      objectDistance: 0,
      rayAngle: 40,
    });
    const ray = traceRays(w)[0];
    const last = ray.points[ray.points.length - 1];
    const before = ray.points[ray.points.length - 2];
    const after = (Math.atan2(last.y - before.y, last.z - before.z) * 180) / Math.PI;
    const expected = (Math.asin(Math.sin((40 * Math.PI) / 180) / 1.5) * 180) / Math.PI;
    expect(after).toBeCloseTo(expected, 6);
    expect(Math.abs(after)).toBeLessThan(40);
  });

  it('stops a ray that misses the glass', () => {
    const w = world({
      view: 'rays',
      surfaces: [glass(0, 60, 1.5, 4), glass(1, -60, 1, 4)],
      rayCount: 3,
      rayHeight: 20,
      objectDistance: 0,
    });
    const rays = traceRays(w);
    expect(rays.some((r) => r.stopped === 'aperture')).toBe(true);
  });
});

describe('the clock a simulation is played against', () => {
  it('ends when the simulation does, in every mode with a fixed run length', () => {
    /* The scrubber runs from 0 to timeline.tMax and the frame shown is
     * t/(dt·decimation). If tMax outruns the simulation, most of the
     * scrubber's travel sits on the final frame and the animation looks
     * frozen — which is what a ten-second default did to a wave that has
     * finished in eighty milliseconds and a wavepacket done in twenty
     * femtoseconds. */
    for (const mode of ['waves', 'quantum'] as const) {
      const tab = makeTab(mode);
      const duration = mode === 'waves' ? tab.waves.world.duration : tab.quantum.world.duration;
      expect(`${mode}: ${tab.timeline.tMax}`).toBe(`${mode}: ${duration}`);
      expect(tab.timeline.tMin).toBe(0);
    }
  });

  it('reaches the last frame at the end of the scrubber and not before', () => {
    const tab = makeTab('waves');
    const field = createWaveField(tab.waves.world);
    advanceWaveField(field, tab.waves.world.duration);
    const frameAt = (t: number) =>
      Math.min(field.count - 1, Math.max(0, Math.round(t / (field.dt * field.decimation))));

    expect(frameAt(0)).toBe(0);
    expect(frameAt(tab.timeline.tMax)).toBe(field.count - 1);
    // And the middle of the scrubber is the middle of the run, within a frame,
    // rather than already pinned to the end.
    expect(Math.abs(frameAt(tab.timeline.tMax / 2) - (field.count - 1) / 2)).toBeLessThan(2);
  });
});

describe('dispersion', () => {
  it('reproduces the Abbe number it was given', () => {
    /* V is *defined* as (n_d − 1)/(n_F − n_C), so a Cauchy curve built from
     * (n_d, V) must give that V back when you measure it at the three
     * Fraunhofer lines. This is the one identity the whole construction has to
     * satisfy, and it fails for any B that was fitted or guessed. */
    for (const [nd, v] of [
      [1.5168, 64.17],
      [1.7847, 25.68],
      [1.6259, 35.7],
      [1.4585, 67.8],
    ] as [number, number][]) {
      const nF = dispersedIndex(nd, v, 486.13);
      const nC = dispersedIndex(nd, v, 656.27);
      expect(dispersedIndex(nd, v, 587.56)).toBeCloseTo(nd, 12);
      expect((nd - 1) / (nF - nC)).toBeCloseTo(v, 6);
    }
  });

  it('bends blue more than red, and not the other way round', () => {
    // Normal dispersion: n falls as wavelength rises, across the whole band.
    let previous = Infinity;
    for (let nm = 380; nm <= 750; nm += 10) {
      const n = dispersedIndex(1.5168, 64.17, nm);
      expect(n).toBeLessThan(previous);
      previous = n;
    }
  });

  it('does nothing at all when the Abbe number is zero', () => {
    for (const nm of [400, 500, 600, 700]) {
      expect(dispersedIndex(1.5, 0, nm)).toBe(1.5);
      expect(dispersedIndex(1.5, -3, nm)).toBe(1.5);
    }
  });

  it('splits white light through a prism, and by more for flint than crown', () => {
    /* The physical claim: a prism separates colours, the separation grows as
     * the Abbe number falls, and a glass with no dispersion separates nothing.
     * Measured as the spread in exit angle across the visible band. */
    const prism = (index: number, abbe: number): WaveWorld =>
      world({
        view: 'rays',
        surfaces: [
          /* A 20° wedge. Steeper than about 22° and the flint stops
           * transmitting at all — its higher index gives it a lower critical
           * angle — which is real, and would make this a test of total
           * internal reflection instead of one of dispersion. */
          { id: 'in', z: 0, radius: 0, tilt: -20, aperture: 40, index, abbe, mirror: false, label: '' },
          { id: 'out', z: 30, radius: 0, tilt: 20, aperture: 40, index: 1, abbe: 0, mirror: false, label: '' },
        ],
        rayCount: 1,
        rayHeight: 0,
        objectDistance: 0,
        rayAngle: 0,
      });

    const spreadOf = (index: number, abbe: number) => {
      const angles = traceSpectrum(prism(index, abbe), 9)
        .filter((r) => r.stopped === null && !r.totalInternal)
        .map((r) => {
          const p = r.points;
          const a = p[p.length - 2];
          const b = p[p.length - 1];
          return Math.atan2(b.y - a.y, b.z - a.z);
        });
      return angles.length > 1 ? Math.max(...angles) - Math.min(...angles) : 0;
    };

    const none = spreadOf(1.5168, 0);
    const crown = spreadOf(1.5168, 64.17);
    const flint = spreadOf(1.7847, 25.68);

    expect(none).toBeCloseTo(0, 12);
    expect(crown).toBeGreaterThan(1e-4);
    // Flint spreads a spectrum about five times wider than crown at the same
    // wedge angle — which is why an achromatic doublet pairs one of each to
    // cancel the colour while keeping the power.
    expect(flint / crown).toBeGreaterThan(4);
    expect(flint / crown).toBeLessThan(8);
  });

  it('gives a lens a red focus beyond its blue one', () => {
    // Longitudinal chromatic aberration: blue refracts more, so it focuses
    // short. For a singlet the shift is roughly f/V.
    const nd = 1.5168;
    const abbe = 64.17;
    const lens = world({
      view: 'rays',
      surfaces: [
        { id: 'a', z: 0, radius: 60, tilt: 0, aperture: 20, index: nd, abbe, mirror: false, label: '' },
        { id: 'b', z: 4, radius: -60, tilt: 0, aperture: 20, index: 1, abbe: 0, mirror: false, label: '' },
      ],
      rayCount: 3,
      rayHeight: 1.5,
      objectDistance: 0,
      rayAngle: 0,
    });
    const focusAt = (nm: number) => {
      const c = axisCrossings(traceRays(lens, nm));
      return c.reduce((a, b) => a + b, 0) / c.length;
    };
    const blue = focusAt(486.13);
    const red = focusAt(656.27);
    const middle = focusAt(587.56);

    expect(red).toBeGreaterThan(blue);
    expect(blue).toBeLessThan(middle);
    expect(red).toBeGreaterThan(middle);
    // f/V is the standard estimate for a thin singlet's chromatic spread.
    expect((red - blue) / (middle / abbe)).toBeGreaterThan(0.6);
    expect((red - blue) / (middle / abbe)).toBeLessThan(1.6);
  });

  it('carries the wavelength and the fan height on every ray it returns', () => {
    // The renderer colours by `wavelength` and relies on rays at ±h being
    // mirror images; both have to actually be there.
    const lens = world({
      view: 'rays',
      surfaces: [
        { id: 'a', z: 0, radius: 60, tilt: 0, aperture: 20, index: 1.5, abbe: 0, mirror: false, label: '' },
        { id: 'b', z: 4, radius: -60, tilt: 0, aperture: 20, index: 1, abbe: 0, mirror: false, label: '' },
      ],
      rayCount: 5,
      rayHeight: 8,
      objectDistance: 0,
      rayAngle: 0,
    });
    const rays = traceRays(lens, 550);
    expect(rays.every((r) => r.wavelength === 550)).toBe(true);
    expect(rays.map((r) => Number(r.height.toFixed(6)))).toEqual([-8, -4, 0, 4, 8]);

    // And the fan is symmetric: the ray at +h ends as the mirror of the one
    // at −h, which is what makes colouring by wavelength look right.
    const last = (r: (typeof rays)[number]) => r.points[r.points.length - 1];
    expect(last(rays[0]).y).toBeCloseTo(-last(rays[4]).y, 9);
    expect(last(rays[0]).z).toBeCloseTo(last(rays[4]).z, 9);

    const spectrum = traceSpectrum(lens, 5);
    expect(spectrum.length).toBe(25);
    expect(new Set(spectrum.map((r) => r.wavelength)).size).toBe(5);
  });
});
