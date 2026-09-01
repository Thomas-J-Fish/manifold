/* Regression test for progressive raster rendering.
 *
 * The fractal and bifurcation renderers fill one ImageData buffer a slice at a
 * time and ask the plot to repaint after each slice. The scene renderer keeps a
 * cached offscreen canvas per ImageData — and if that cache also caches the
 * *pixels*, every repaint after the first draws the first slice again. The
 * picture freezes while the progress caption counts up to 100%, which no
 * screenshot and no numerical test can see.
 *
 * The DOM is stubbed rather than emulated: this needs exactly two things from
 * it, and jsdom's canvas is not one of the things it provides.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drawScene, type PlotScene } from '../src/plot/scene';

interface FakeContext {
  puts: { width: number; height: number; token: number }[];
  [key: string]: unknown;
}

const NOOP = () => undefined;

/** A 2D context that records putImageData and ignores everything else. */
function makeContext(puts: FakeContext['puts']): CanvasRenderingContext2D {
  const context: Record<string, unknown> = {
    putImageData: (data: { width: number; height: number; token: number }) =>
      puts.push({ width: data.width, height: data.height, token: data.token }),
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop: NOOP }),
  };
  // Every other 2D-context method the renderer might reach for is a no-op; the
  // test only cares about the one call that reveals the caching behaviour.
  for (const name of [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo', 'rect',
    'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'fillText', 'strokeText', 'setLineDash',
    'drawImage', 'translate', 'rotate', 'scale', 'setTransform',
  ]) {
    context[name] = NOOP;
  }
  return context as unknown as CanvasRenderingContext2D;
}

let puts: FakeContext['puts'];
let originalDocument: unknown;
let originalImageData: unknown;

beforeEach(() => {
  puts = [];
  originalDocument = (globalThis as Record<string, unknown>).document;
  originalImageData = (globalThis as Record<string, unknown>).ImageData;

  (globalThis as Record<string, unknown>).ImageData = class {
    constructor(
      public width: number,
      public height: number,
    ) {}
    token = 0;
  };

  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => makeContext(puts) }),
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).ImageData = originalImageData;
});

describe('raster layers', () => {
  it('re-uploads the pixels on every paint of the same buffer', () => {
    const ImageDataCtor = (globalThis as Record<string, unknown>).ImageData as new (
      w: number,
      h: number,
    ) => { width: number; height: number; token: number };
    const buffer = new ImageDataCtor(64, 48);

    const scene = (): PlotScene => ({
      viewport: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      showGrid: false,
      showMinorGrid: false,
      showAxes: false,
      layers: [
        { type: 'image', image: buffer as unknown as ImageData, x0: 0, y0: 0, x1: 1, y1: 1 },
      ],
    });

    const ctx = makeContext(puts);

    buffer.token = 1;
    drawScene(ctx, scene(), 400, 300);
    expect(puts.length).toBe(1);
    expect(puts[0].token).toBe(1);

    // The renderer fills more of the same buffer and repaints. The second paint
    // must upload the new contents, not replay the cached first frame.
    buffer.token = 2;
    drawScene(ctx, scene(), 400, 300);
    expect(puts.length).toBe(2);
    expect(puts[1].token).toBe(2);

    buffer.token = 3;
    drawScene(ctx, scene(), 400, 300);
    expect(puts[2].token).toBe(3);
  });

  it('reuses one offscreen canvas per buffer rather than allocating each paint', () => {
    let created = 0;
    (globalThis as Record<string, unknown>).document = {
      createElement: () => {
        created++;
        return { width: 0, height: 0, getContext: () => makeContext(puts) };
      },
    };

    const ImageDataCtor = (globalThis as Record<string, unknown>).ImageData as new (
      w: number,
      h: number,
    ) => { width: number; height: number; token: number };
    const buffer = new ImageDataCtor(32, 32);
    const ctx = makeContext(puts);
    const scene: PlotScene = {
      viewport: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
      showGrid: false,
      showMinorGrid: false,
      showAxes: false,
      layers: [{ type: 'image', image: buffer as unknown as ImageData, x0: 0, y0: 0, x1: 1, y1: 1 }],
    };

    for (let i = 0; i < 5; i++) drawScene(ctx, { ...scene, layers: [...scene.layers] }, 400, 300);
    // One canvas for the gutter measurement in each paint is unavoidable; what
    // matters is that the raster canvas itself is not re-created five times.
    expect(created).toBeLessThan(5);
  });
});
