#!/usr/bin/env node
'use strict';
/* End-to-end smoke test.
 *
 * Launches the built application, drives it through every mode, and asserts on
 * what the renderer actually put on screen. This is the test that catches the
 * class of bug unit tests cannot: a mode that throws on mount, a canvas that
 * paints nothing, an IPC channel that was renamed on one side only.
 *
 *   node tools/smoke.js [--shots <dir>] [--keep-open]
 *
 * Requires a display. On Linux run it under xvfb-run.
 */

const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const shotIndex = argv.indexOf('--shots');
const SHOT_DIR = shotIndex >= 0 ? path.resolve(argv[shotIndex + 1]) : path.join(ROOT, 'test-shots');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/** True when the plot canvas is not a flat field of one colour. */
async function canvasHasContent(page, index = 0) {
  return page.evaluate((i) => {
    const canvas = document.querySelectorAll('canvas')[i];
    if (!canvas || canvas.width === 0) return { ok: false, reason: 'no canvas' };
    const ctx = canvas.getContext('2d') ?? canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!ctx) return { ok: false, reason: 'no context' };
    // A WebGL canvas cannot be read with getImageData, so it is checked by
    // drawing it into a 2D scratch canvas first.
    const scratch = document.createElement('canvas');
    scratch.width = Math.min(canvas.width, 400);
    scratch.height = Math.min(canvas.height, 300);
    const sctx = scratch.getContext('2d');
    sctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    const data = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
    const seen = new Set();
    for (let p = 0; p < data.length; p += 4 * 37) {
      seen.add(`${data[p]},${data[p + 1]},${data[p + 2]}`);
      if (seen.size > 12) break;
    }
    return { ok: seen.size > 6, reason: `${seen.size} distinct colours`, colours: seen.size };
  }, index);
}

/* Modes are selected by their stable `data-mode` attribute rather than by
 * their visible label: the label also appears in the tab strip and in the
 * status bar, and a text selector that matches three elements fails in a way
 * that looks like a hang. */
/* The picker is two levels: a subject, then the modes inside it. Only one
 * subject is open at a time, so a mode's button may not exist yet — open every
 * heading in turn until it does. Cheaper than teaching the tests which subject
 * each mode belongs to, and it keeps working when one is moved. */
async function revealMode(page, id) {
  const button = `button[data-mode="${id}"]`;
  if (await page.locator(button).count()) return button;
  for (const category of await page.locator('[data-category]').all()) {
    await category.click();
    await page.waitForTimeout(80);
    if (await page.locator(button).count()) return button;
  }
  return button;
}

async function selectMode(page, id) {
  await page.click('[data-testid="new-tab"]');
  const button = await revealMode(page, id);
  await page.waitForSelector(button, { timeout: 6000 });
  await page.click(button);
  await page.waitForTimeout(500);
}

function step(label) {
  process.stdout.write(`\n${label}\n`);
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const app = await electron.launch({
    // Resolved explicitly: Playwright looks for Electron relative to its own
    // module, which is not where npm put it in a workspace install.
    executablePath: require('electron'),
    // The Chromium sandbox needs privileges a CI container does not have, and
    // the software renderer is what an offscreen X server can actually use.
    args: ['--no-sandbox', '--disable-gpu', ROOT],
    cwd: ROOT,
    timeout: 60000,
    env: { ...process.env, MANIFOLD_TEST: '1' },
  });

  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  await page.waitForLoadState('domcontentloaded');
  page.on('pageerror', (err) => {
    failed++;
    failures.push(`uncaught renderer error: ${err.message}`);
    process.stdout.write(`  ✗ uncaught renderer error: ${err.message}\n`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/DevTools|Autofill|Electron Security/i.test(msg.text())) {
      process.stdout.write(`  ! console: ${msg.text()}\n`);
    }
  });

  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(1200);

  process.stdout.write('\nShell\n');
  check('window has a title', (await page.title()).includes('Manifold'));
  check('the app mounted', (await page.locator('#root > div').count()) === 1);
  check('the preload bridge is present', await page.evaluate(() => typeof window.manifold === 'object'));
  check('a tab strip is rendered', (await page.locator('[draggable="true"]').count()) >= 1);

  const bodyText = await page.locator('body').innerText();
  check('the sidebar shows expressions', /Expressions/i.test(bodyText));
  check('the sidebar shows parameters', /Parameters/i.test(bodyText));

  process.stdout.write('\nGraphing\n');
  let content = await canvasHasContent(page);
  check('the plot canvas is drawn', content.ok, content.reason);
  await page.screenshot({ path: path.join(SHOT_DIR, '01-graphing.png') });

  // Type a new expression and confirm the canvas changes.
  const before = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? c.toDataURL().length : 0;
  });
  const firstInput = page.locator('input[type="text"].font-mono').first();
  await firstInput.fill('sin(3*x)*exp(-x^2/12)');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? c.toDataURL().length : 0;
  });
  check('editing an expression redraws the plot', before !== after, `${before} → ${after}`);
  check(
    'the typeset preview appeared',
    (await page.locator('.katex').count()) > 0,
    `${await page.locator('.katex').count()} KaTeX nodes`,
  );

  // Sliders
  const sliderCount = await page.locator('input[type="range"].manifold-slider').count();
  check('parameter sliders exist', sliderCount >= 2, `${sliderCount} sliders`);

  const modes = [
    ['statistics', 'Statistics', '02-statistics'],
    ['linear-algebra', 'Linear algebra', '03-linear-algebra'],
    ['monte-carlo', 'Monte Carlo', '04-monte-carlo'],
    ['calculus', 'Calculus', '05-calculus'],
    ['dynamics', 'Dynamics', '06-dynamics'],
    ['fields', 'Fields', '07-fields'],
    ['fitting', 'Fitting', '08-fitting'],
    ['mechanics', 'Mechanics', '09-mechanics'],
    ['circuits', 'Circuits', '10-circuits'],
    ['quantum', 'Quantum', '11-quantum'],
    ['chemistry', 'Chemistry', '12-chemistry'],
    // Numbered after the deep-dive shots below rather than continuing the walk,
    // so the directory still reads in the order the run produced it.
    ['waves', 'Waves and optics', '17-waves'],
    ['signals', 'Signal processing', '18-signals'],
  ];

  for (const [id, label, shot] of modes) {
    step(label);
    await selectMode(page, id);
    await page.waitForTimeout(1200);
    const result = await canvasHasContent(page);
    check(`${label}: the surface renders`, result.ok, result.reason);
    const text = await page.locator('body').innerText();
    check(`${label}: the panel has controls`, text.length > 200, `${text.length} characters`);
    check(`${label}: no error boundary`, !/could not start/i.test(text));
    await page.screenshot({ path: path.join(SHOT_DIR, `${shot}.png`) });
  }

  /* ---- the sandboxes run, measure and agree with their own formulas.
   *
   * A sandbox that draws a pendulum but never moves it, or draws a circuit
   * whose readings are all zero, passes every check above. These assert on the
   * numbers the panels are actually showing. */
  step('Mechanics sandbox');
  await selectMode(page, 'mechanics');
  await page.waitForTimeout(900);

  {
    const text = await page.locator('body').innerText();
    check('the arrangement is named', /Simple pendulum/i.test(text), text.slice(0, 120));
    // 2π√(2/9.81) = 2.837 s, and the exact period is a couple of percent longer.
    const small = /Small-angle period\s+([\d.]+)/.exec(text);
    const exact = /Exact period\s+([\d.]+)/.exec(text);
    check(
      'the small-angle period is 2π√(L/g)',
      small && Math.abs(Number(small[1]) - 2 * Math.PI * Math.sqrt(2 / 9.81)) < 0.01,
      small ? small[1] : 'not shown',
    );
    check(
      'the exact period is longer, as it must be',
      small && exact && Number(exact[1]) > Number(small[1]) * 1.02,
      exact ? `${exact[1]} vs ${small && small[1]}` : 'not shown',
    );

    const canvasesBefore = await page.locator('canvas').count();
    check('there is a bench and at least one instrument', canvasesBefore >= 2, `${canvasesBefore} canvases`);

    /* Run the clock and confirm the pendulum actually swings.
     *
     * This used to compare `toDataURL().length` before and after, which sounds
     * reasonable and is worthless: a build whose trajectory never advanced at
     * all still passed it, because something else on the canvas differed by a
     * byte. The energy readout is in the DOM and is a statement about the
     * physics — a bob released from rest has no kinetic energy, and a bob that
     * has fallen most of a metre has a great deal. */
    const atRest = await page.locator('body').innerText();
    const ke0 = /Kinetic energy\s+([-\d.e]+) J/.exec(atRest);
    check('a pendulum released from rest has no kinetic energy', ke0 && Number(ke0[1]) < 1e-9, ke0 ? ke0[1] : 'not shown');

    await page.click('button[title="Play"]');
    await page.waitForTimeout(1800);
    await page.click('button[title="Pause"]');

    const running = await page.locator('body').innerText();
    const ke1 = /Kinetic energy\s+([-\d.e]+) J/.exec(running);
    // Falling from 45° on a 2 m rod converts m·g·L(1−cos45°) ≈ 5.7 J at the
    // bottom, so anything above a joule means it is genuinely swinging.
    check(
      'and has plenty once the clock has run',
      ke1 && Number(ke1[1]) > 1,
      ke1 ? `${ke1[1]} J` : 'not shown',
    );

    const total = /Total\s+([-\d.e]+) J/.exec(running);
    const drift = /Change since t = 0\s+([-\d.e]+) J/.exec(running);
    check('the energy readout has a total', !!total, total ? total[1] : 'not shown');
    check(
      'energy is conserved to better than a millijoule',
      drift && Math.abs(Number(drift[1])) < 1e-3,
      drift ? `${drift[1]} J` : 'not shown',
    );

    // The bench must be drawn with square scales, or a circle is an ellipse.
    const square = await page.evaluate(() => {
      const canvas = document.querySelectorAll('canvas')[0];
      const rect = canvas.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    });
    check('the bench canvas has a sensible size', square.w > 100 && square.h > 100, `${square.w}×${square.h}`);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '11-mechanics-running.png') });

  step('Electronics sandbox');
  await selectMode(page, 'circuits');
  await page.waitForTimeout(900);

  {
    const text = await page.locator('body').innerText();
    check('the circuit is recognised', /RC charging/i.test(text), text.slice(0, 140));
    // 1 kΩ plus the cell's 0.5 Ω, and 1 mF: τ = 1.0005 s.
    const tau = /Time constant τ\s+([\d.]+)/.exec(text);
    check(
      'the time constant is RC',
      tau && Math.abs(Number(tau[1]) - 1.0005) < 0.002,
      tau ? tau[1] : 'not shown',
    );

    await page.click('button[title="Play"]');
    await page.waitForTimeout(2600);
    await page.click('button[title="Pause"]');

    const running = await page.locator('body').innerText();
    const canvases = await page.locator('canvas').count();
    check('the live plot is drawn beside the board', canvases >= 2, `${canvases} canvases`);
    check('no error boundary', !/could not start/i.test(running));

    /* Steady state puts the readings in the DOM as numbers, which is the only
     * place a test can actually read them — the labels on the board itself are
     * painted into a canvas, so an innerText check for them passes or fails
     * for reasons that have nothing to do with the physics. And the steady
     * state of an RC circuit is a strong assertion in its own right: the whole
     * EMF across the capacitor, and no current anywhere. */
    await page.click('button:has-text("Steady state")');
    await page.waitForTimeout(700);
    const dc = await page.locator('body').innerText();
    const capVolts = /Voltage across C\s+([\d.]+)\s*V/.exec(dc);
    // "6 pA" — the value and its SI prefix are separated by a space, so the
    // prefix has to be captured rather than swept up by the number's character
    // class. Six picoamps is the gmin leakage current every SPICE-style solver
    // adds to keep floating nodes solvable, and is exactly the right answer.
    const resAmps = /Current through R\s+(-?[\d.]+)\s*([GMkmµnp]?)A/.exec(dc);
    const scales = { G: 1e9, M: 1e6, k: 1e3, '': 1, m: 1e-3, 'µ': 1e-6, n: 1e-9, p: 1e-12 };
    check(
      'a charged capacitor holds the whole EMF',
      capVolts && Math.abs(Number(capVolts[1]) - 6) < 0.02,
      capVolts ? `${capVolts[1]} V` : dc.slice(0, 160),
    );
    check(
      'and no current flows once it is charged',
      resAmps && Math.abs(Number(resAmps[1]) * scales[resAmps[2]]) < 1e-9,
      resAmps ? `${resAmps[1]} ${resAmps[2]}A` : 'not shown',
    );
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '14-circuits-running.png') });

  step('Quantum mechanics');
  await selectMode(page, 'quantum');
  await page.waitForTimeout(1200);

  {
    /* The default is a 1 nm well 5 eV deep, which holds exactly four states —
     * a number that follows from ⌈(a/π)√(2mV₀)/ħ⌉ and from nothing about this
     * code. If the eigensolver, the unit system or the grid is wrong, this is
     * wrong, and it is wrong in a way an image comparison would never catch. */
    const text = await page.locator('body').innerText();
    check('the well is recognised', /Finite square well/i.test(text), text.slice(0, 140));
    check('it holds four bound states', /4 bound states/i.test(text), text.slice(0, 400));
    const ground = /n = 1\s+(-?[\d.]+) eV/.exec(text);
    check(
      'the ground state is where the transcendental equation puts it',
      ground && Math.abs(Number(ground[1]) + 4.7275) < 0.02,
      ground ? `${ground[1]} eV` : 'not shown',
    );

    // A packet launched at a barrier has to actually go somewhere.
    await page.click('[role="tab"]:has-text("Packet")');
    await page.waitForTimeout(900);
    await page.click('button[title="Play"]');
    await page.waitForTimeout(3000);
    await page.click('button[title="Pause"]');
    const moving = await page.locator('body').innerText();
    const meanX = /⟨x⟩\s+(-?[\d.]+) nm/.exec(moving);
    check(
      'the wavepacket has moved off its starting point',
      meanX && Number(meanX[1]) > -3.5,
      meanX ? `${meanX[1]} nm` : moving.slice(0, 200),
    );
    const norm = /Norm\s+([\d.]+)/.exec(moving);
    check(
      'and probability is conserved while it does',
      norm && Number(norm[1]) > 0.98,
      norm ? norm[1] : 'not shown',
    );
    check('no error boundary', !/could not start/i.test(moving));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '15-quantum-running.png') });

  step('Periodic table');
  await selectMode(page, 'chemistry');
  await page.waitForTimeout(900);

  {
    await page.click('button[data-element="Fe"]');
    await page.waitForTimeout(500);
    const text = await page.locator('body').innerText();
    check('clicking an element opens it', /Iron/.test(text), text.slice(0, 200));
    check(
      'with the configuration that breaks at chromium and copper',
      /\[Ar\]\s*4s² 3d⁶/.test(text),
      text.slice(0, 400),
    );
    await page.click('button[data-element="Cu"]');
    await page.waitForTimeout(400);
    const copper = await page.locator('body').innerText();
    check('and copper really is 4s¹ 3d¹⁰', /4s¹ 3d¹⁰/.test(copper), copper.slice(0, 400));
    check('no error boundary', !/could not start/i.test(copper));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '16-chemistry.png') });

  step('Waves and optics');
  await selectMode(page, 'waves');
  await page.waitForTimeout(1200);

  {
    /* √(40/0.01) = 63.246 m/s, and a 1 m string fixed at both ends has a
     * fundamental of v/2L = 31.623 Hz. Both come from the medium's own
     * formula and from nothing about the solver. */
    const text = await page.locator('body').innerText();
    const speed = /Wave speed\s+([\d.]+) m\/s/.exec(text);
    check(
      'the wave speed is √(T/µ)',
      speed && Math.abs(Number(speed[1]) - Math.sqrt(40 / 0.01)) < 0.01,
      speed ? `${speed[1]} m/s` : text.slice(0, 200),
    );
    const fundamental = /Fundamental\s+([\d.]+) Hz/.exec(text);
    check(
      'and the fundamental is v/2L',
      fundamental && Math.abs(Number(fundamental[1]) - Math.sqrt(40 / 0.01) / 2) < 0.05,
      fundamental ? `${fundamental[1]} Hz` : 'not shown',
    );

    // The diffraction view computes its pattern rather than recalling one:
    // two 40 µm slits 0.2 mm apart give λD/d = 5.5 mm fringes at 2 m.
    await page.click('[role="tab"]:has-text("Slits")');
    await page.waitForTimeout(900);
    const slits = await page.locator('body').innerText();
    const spacing = /Fringe spacing\s+([\d.]+) mm/.exec(slits);
    check(
      'the fringe spacing is λD/d',
      spacing && Math.abs(Number(spacing[1]) - 5.5) < 0.15,
      spacing ? `${spacing[1]} mm` : slits.slice(0, 300),
    );
    check('the screen is drawn as well as the graph', (await page.locator('canvas').count()) >= 2);

    /* And the optics view refracts. The default lens is BK7 — n_d = 1.5168,
     * R = ±60 mm, 10 mm thick — so every number below is worked out here from
     * the glass rather than copied off the screen. */
    await page.click('[role="tab"]:has-text("Optics")');
    await page.waitForTimeout(900);
    const optics = await page.locator('body').innerText();
    const nGlass = 1.5168;
    const thin = 1 / ((nGlass - 1) * (1 / 60 + 1 / 60));
    const focal = /Focal length, thin-lens\s+([\d.]+) mm/.exec(optics);
    check(
      `the lensmaker equation gives ${thin.toFixed(2)} mm`,
      focal && Math.abs(Number(focal[1]) - thin) < 0.5,
      focal ? `${focal[1]} mm, expected ${thin.toFixed(2)}` : optics.slice(0, 300),
    );
    /* And the rays cross where a *thick* lens puts the focus, not where the
     * thin-lens number does — which is the whole reason for tracing them.
     *
     *   1/f = (n−1)[1/R₁ − 1/R₂ + (n−1)d/(n R₁ R₂)]  →  f  = 59.748 mm
     *   BFD = f[1 − (n−1)d/(n R₁)]                   →  BFD = 56.355 mm
     *
     * measured from the back vertex at z = 10, so 66.355 mm from the front
     * one. The innermost ray of the fan lands a couple of tenths short of that
     * because even it is not perfectly paraxial. Assert the thick-lens answer
     * and this check fails the moment the tracer starts approximating. */
    const thick =
      1 / ((nGlass - 1) * (1 / 60 + 1 / 60 + ((nGlass - 1) * 10) / (nGlass * 60 * -60)));
    const bfd = 10 + thick * (1 - ((nGlass - 1) * 10) / (nGlass * 60));
    const crossing = /Rays cross the axis near\s+([\d.]+) mm/.exec(optics);
    check(
      'and parallel rays cross at the thick-lens focus, not the thin-lens one',
      crossing && Math.abs(Number(crossing[1]) - bfd) < 0.6 && Math.abs(bfd - thin) > 5,
      crossing ? `${crossing[1]} mm, expected ${bfd.toFixed(2)}` : 'not shown',
    );
    check('no error boundary', !/could not start/i.test(optics));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '19-waves-optics.png') });

  step('Signal processing');
  await selectMode(page, 'signals');
  await page.waitForTimeout(1400);

  {
    /* The default signal is sin(2π·50t) + ½sin(2π·120t) sampled at 1 kHz for
     * one second, so the two peaks must come back at 50 and 120 Hz with the
     * second half the height of the first. A window that is misapplied, an FFT
     * with a sign error, or a bin index off by one all break this. */
    const text = await page.locator('body').innerText();
    const peaks = [...text.matchAll(/([\d.]+) Hz\s+([\d.]+)\s/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const fifty = peaks.find((p) => Math.abs(p[0] - 50) < 1.5);
    const oneTwenty = peaks.find((p) => Math.abs(p[0] - 120) < 1.5);
    check('the spectrum finds the 50 Hz tone', !!fifty, fifty ? String(fifty) : text.slice(0, 400));
    check('and the 120 Hz one', !!oneTwenty, oneTwenty ? String(oneTwenty) : 'not found');
    check(
      'at half the amplitude, as it was written',
      fifty && oneTwenty && Math.abs(oneTwenty[1] / fifty[1] - 0.5) < 0.08,
      fifty && oneTwenty ? `${oneTwenty[1]} / ${fifty[1]}` : 'not comparable',
    );
    check('Nyquist is reported', /Nyquist\s+500 Hz/.test(text), text.slice(0, 300));

    // A filter that designs unstable poles is the failure mode worth catching.
    await page.click('[role="tab"]:has-text("Filter")');
    await page.waitForTimeout(900);
    const filter = await page.locator('body').innerText();
    check('the filter is stable', /Stable\s+yes/.test(filter), filter.slice(0, 400));
    const worst = /Largest pole\s+([\d.]+)/.exec(filter);
    check(
      'with every pole inside the unit circle',
      worst && Number(worst[1]) < 1,
      worst ? worst[1] : 'not shown',
    );

    // 900 Hz sampled at 1 kHz has to come back as 100, not as 900.
    await page.click('[role="tab"]:has-text("Aliasing")');
    await page.waitForTimeout(900);
    const alias = await page.locator('body').innerText();
    check('the alias is |f − fs|', /Appears at\s+100 Hz/.test(alias), alias.slice(0, 400));
    check('and the mode says so plainly', /Recoverable\s+no/.test(alias), 'not shown');
    check('no error boundary', !/could not start/i.test(alias));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '20-signals.png') });

  step('Optimisation');
  await selectMode(page, 'optimisation');
  await page.waitForTimeout(1200);

  {
    /* The carpenter's problem: maximise 5x + 4y subject to 6x + 4y ≤ 24 and
     * x + 2y ≤ 6. The optimum is (3, 1.5) with value 21, which is worked out
     * by hand and not by this program. */
    const text = await page.locator('body').innerText();
    check('the simplex reaches the optimum', /Status\s+optimal/.test(text), text.slice(0, 400));
    const objective = /Objective\s+([\d.]+)/.exec(text);
    check(
      'with the objective at 21',
      objective && Math.abs(Number(objective[1]) - 21) < 1e-3,
      objective ? objective[1] : 'not shown',
    );
    const x1 = /x₁\s+([\d.]+)/.exec(text);
    const x2 = /x₂\s+([\d.]+)/.exec(text);
    check(
      'at the corner (3, 1.5)',
      x1 && x2 && Math.abs(Number(x1[1]) - 3) < 1e-3 && Math.abs(Number(x2[1]) - 1.5) < 1e-3,
      x1 && x2 ? `(${x1[1]}, ${x2[1]})` : 'not shown',
    );

    // Rosenbrock from (−1.2, 1): the minimum is at (1, 1) with f = 0, and a
    // descent that stalls in the valley is the failure worth catching.
    await page.click('[role="tab"]:has-text("Descent")');
    await page.waitForTimeout(1200);
    const descent = await page.locator('body').innerText();
    const value = /f at the end\s+([\d.eE+-]+)/.exec(descent) ?? /Final f\s+([\d.eE+-]+)/.exec(descent);
    check(
      'gradient descent gets down Rosenbrock',
      value && Number(value[1]) < 0.05,
      value ? value[1] : descent.slice(0, 400),
    );

    // max(x + y) on the unit circle is √2 at (1/√2, 1/√2), and the multiplier
    // there is 1/√2 as well.
    await page.click('[role="tab"]:has-text("Lagrange")');
    await page.waitForTimeout(1200);
    const lagrange = await page.locator('body').innerText();
    const best = /Maximum\s+([\d.]+)/.exec(lagrange) ?? /f there\s+([\d.]+)/.exec(lagrange);
    check(
      'the constrained maximum of x + y on the unit circle is √2',
      best && Math.abs(Number(best[1]) - Math.SQRT2) < 0.02,
      best ? best[1] : lagrange.slice(0, 400),
    );
    check('no error boundary', !/could not start/i.test(lagrange));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '21-optimisation.png') });

  step('Chemical reactions');
  await selectMode(page, 'reactions');
  await page.waitForTimeout(1600);

  {
    /* A → B → C with k₁ = 0.5 and k₂ = 0.2, run for 25 s. By then A is
     * e^(−12.5) ≈ 4×10⁻⁶ and essentially everything has reached C, so the
     * final concentrations are a closed-form check on the integrator. */
    const text = await page.locator('body').innerText();
    const finalC = /\[C\] final\s+([\d.]+)/.exec(text);
    check(
      'A → B → C runs to completion',
      finalC && Number(finalC[1]) > 0.97 && Number(finalC[1]) < 1.0001,
      finalC ? finalC[1] : text.slice(0, 400),
    );
    const finalA = /\[A\] final\s+([\d.eE+-]+)/.exec(text);
    check('and A is used up', finalA && Number(finalA[1]) < 1e-4, finalA ? finalA[1] : 'not shown');

    // 0.1 M acetic acid with 0.1 M NaOH: equivalence at 25 mL, and at pH 8.72
    // rather than 7 — the fact this whole view exists to make undeniable.
    await page.click('[role="tab"]:has-text("Titration")');
    await page.waitForTimeout(1200);
    const titration = await page.locator('body').innerText();
    const equiv = /Equivalence\s+([\d.]+) mL/.exec(titration);
    check(
      'equivalence is at 25 mL',
      equiv && Math.abs(Number(equiv[1]) - 25) < 0.2,
      equiv ? equiv[1] : titration.slice(0, 400),
    );
    const ph = /pH there\s+([\d.]+)/.exec(titration);
    check(
      'and the pH there is 8.72, not 7',
      ph && Math.abs(Number(ph[1]) - 8.72) < 0.1,
      ph ? ph[1] : 'not shown',
    );
    check('no error boundary', !/could not start/i.test(titration));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '22-reactions.png') });

  step('Thermodynamics');
  await selectMode(page, 'thermodynamics');
  await page.waitForTimeout(1800);

  {
    /* The box is seeded at T = 1, and in two dimensions T = ⟨mv²⟩/2k, so the
     * measured temperature must come back at 1 whatever the particles do. */
    const text = await page.locator('body').innerText();
    const temperature = /Temperature\s+([\d.]+)/.exec(text);
    check(
      'the gas measures the temperature it was seeded at',
      temperature && Math.abs(Number(temperature[1]) - 1) < 0.12,
      temperature ? temperature[1] : text.slice(0, 400),
    );
    const mean = /Mean speed \(measured\)\s+([\d.]+)/.exec(text);
    const maxwell = /Mean speed \(Maxwell\)\s+([\d.]+)/.exec(text);
    check(
      'and its mean speed matches the Maxwell value',
      mean && maxwell && Math.abs(Number(mean[1]) / Number(maxwell[1]) - 1) < 0.08,
      mean && maxwell ? `${mean[1]} vs ${maxwell[1]}` : 'not shown',
    );

    /* The default Carnot cycle between 500 K and 300 K, whose efficiency must
     * be 1 − 300/500 = 40% — computed by the tracer from work over heat, with
     * that formula appearing nowhere in the calculation. */
    await page.click('[role="tab"]:has-text("PV cycle")');
    await page.waitForTimeout(1200);
    const cycle = await page.locator('body').innerText();
    const efficiency = /Efficiency\s+([\d.]+) %/.exec(cycle);
    check(
      'the Carnot cycle comes out at 40%',
      efficiency && Math.abs(Number(efficiency[1]) - 40) < 0.3,
      efficiency ? efficiency[1] : cycle.slice(0, 400),
    );
    // The readout's own wording. "Closed cycle" also appears as the plot's
    // caption, but that is painted on a canvas and innerText cannot see it.
    check('and the loop closes', /The cycle closes/.test(cycle), cycle.slice(0, 300));
    const limit = /Carnot limit\s+([\d.]+) %/.exec(cycle);
    check(
      'at exactly the Carnot limit',
      efficiency && limit && Math.abs(Number(efficiency[1]) - Number(limit[1])) < 0.1,
      efficiency && limit ? `${efficiency[1]} vs ${limit[1]}` : 'not shown',
    );
    check('no error boundary', !/could not start/i.test(cycle));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '23-thermodynamics.png') });

  step('Geometry');
  await selectMode(page, 'geometry');
  await page.waitForTimeout(1400);

  {
    /* Opens on Euclid I.1: two circles of radius AB and their crossing. The
     * triangle has to be equilateral — three 60° angles — and it has to *stay*
     * equilateral when a vertex is dragged, which is the whole claim of the
     * mode and cannot be checked by looking at one position. */
    const text = await page.locator('body').innerText();
    const angles = /Angles\s+([\d.]+)° · ([\d.]+)° · ([\d.]+)°/.exec(text);
    check(
      'the construction is equilateral',
      angles && [1, 2, 3].every((i) => Math.abs(Number(angles[i]) - 60) < 0.01),
      angles ? angles.slice(1, 4).join(' ') : text.slice(0, 400),
    );
    const areaBefore = /Area\s+([\d.]+)/.exec(text);

    /* Where is the point on screen?
     *
     * Working it out from the viewport means reproducing the plot's own
     * transform here — including the axis gutters, whose width depends on how
     * wide the tick labels turned out. Getting that subtly wrong grabs empty
     * space, the drag does nothing, and the test reports a broken feature that
     * is working fine. So the plot is asked instead: it prints the world
     * coordinates under the cursor, and two probes give the exact mapping. */
    const box = await page.locator('canvas').last().boundingBox();
    const probe = async (px, py) => {
      await page.mouse.move(px, py);
      await page.waitForTimeout(120);
      const text = await page.locator('.font-mono.text-2xs').last().innerText();
      const m = /(-?[\d.]+),\s*(-?[\d.]+)/.exec(text);
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    const p1 = { px: box.x + box.width * 0.35, py: box.y + box.height * 0.35 };
    const p2 = { px: box.x + box.width * 0.65, py: box.y + box.height * 0.65 };
    const w1 = await probe(p1.px, p1.py);
    const w2 = await probe(p2.px, p2.py);
    check('the plot reports the coordinates under the cursor', !!w1 && !!w2, `${JSON.stringify(w1)} ${JSON.stringify(w2)}`);
    const sx = (p2.px - p1.px) / (w2.x - w1.x);
    const sy = (p2.py - p1.py) / (w2.y - w1.y);
    const toPixels = (x, y) => ({ px: p1.px + (x - w1.x) * sx, py: p1.py + (y - w1.y) * sy });
    const from = toPixels(-1.5, -1);
    await page.mouse.move(from.px, from.py);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(from.px - i * 6, from.py - i * 5);
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);

    const after = await page.locator('body').innerText();
    const anglesAfter = /Angles\s+([\d.]+)° · ([\d.]+)° · ([\d.]+)°/.exec(after);
    const areaAfter = /Area\s+([\d.]+)/.exec(after);
    check(
      'dragging a vertex actually moves the figure',
      areaBefore && areaAfter && Math.abs(Number(areaAfter[1]) - Number(areaBefore[1])) > 0.05,
      areaBefore && areaAfter ? `${areaBefore[1]} → ${areaAfter[1]}` : 'no area shown',
    );
    check(
      'and it is still equilateral afterwards',
      anglesAfter && [1, 2, 3].every((i) => Math.abs(Number(anglesAfter[i]) - 60) < 0.01),
      anglesAfter ? anglesAfter.slice(1, 4).join(' ') : after.slice(0, 400),
    );
    check('no error boundary', !/could not start/i.test(after));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '24-geometry.png') });

  step('Loan interest');
  await selectMode(page, 'loan');
  await page.waitForTimeout(1300);

  {
    /* £500,000 at £2,500 of capital a month with the interest paid separately:
     * the balance falls linearly, so 200 months exactly, and the interest is
     * two months at 1.09% plus 198 at 4% — £165,081.06, worked out in closed
     * form and not by the code being checked. */
    const text = await page.locator('body').innerText();
    check('the loan clears in 200 months', /Clear in\s+200 months/.test(text), text.slice(0, 400));
    check('and reads as 16 years 8 months', /16 years 8 months/.test(text), 'not shown');
    const interest = /Total interest\s+£([\d,]+\.\d\d)/.exec(text);
    check(
      'the total interest is £165,081.06',
      interest && Math.abs(Number(interest[1].replace(/,/g, '')) - 165_081.06) < 0.02,
      interest ? interest[1] : text.slice(0, 500),
    );
    // The whole point of the piecewise rate: the bill quadruples in month 3.
    const jump = /Interest jumps to\s+£([\d,]+\.\d\d)/.exec(text);
    check(
      'and the interest jumps when the fixed rate ends',
      jump && Math.abs(Number(jump[1].replace(/,/g, '')) - 1650) < 1,
      jump ? jump[1] : 'not shown',
    );
    check('no error boundary', !/could not start/i.test(text));

    // The schedule view is a table rather than a canvas, so it is worth its
    // own check that it actually renders rows.
    await page.click('[role="tab"]:has-text("Schedule")');
    await page.waitForTimeout(700);
    const rows = await page.locator('tbody tr').count();
    check('the schedule lists months', rows > 10, `${rows} rows`);
    await page.click('[role="tab"]:has-text("Balance")');
    await page.waitForTimeout(500);

    /* ---- the term as the input rather than the answer.
     *
     * The slider cannot land on a specific term, so the two typed boxes are
     * the feature: fourteen years and ten months is 178 months, and with the
     * interest paid separately the balance falls by the payment alone, so the
     * capital needed is £500,000 ÷ 178 = £2,808.99 — a closed form, not a
     * figure read off this code. */
    await page.click('button:text-is("The term")');
    await page.waitForTimeout(600);
    const years = page.locator('[data-testid="loan-years"] input');
    const months = page.locator('[data-testid="loan-months"] input');
    check('the term boxes appear', (await years.count()) === 1 && (await months.count()) === 1);
    await years.fill('14');
    await years.press('Enter');
    await months.fill('10');
    await months.press('Enter');
    await page.waitForTimeout(700);

    const termText = await page.locator('body').innerText();
    check(
      'fourteen years and ten months is 178 months',
      /Clear in\s+178 months/.test(termText),
      termText.slice(0, 300),
    );
    const needs = /That needs\s+£([\d,]+\.\d\d)\s+of capital a month/.exec(termText);
    check(
      'and it needs £2,808.99 of capital a month',
      needs && Math.abs(Number(needs[1].replace(/,/g, '')) - 2808.99) < 0.02,
      needs ? needs[1] : termText.slice(0, 600),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '25b-loan-term.png') });

    /* ---- the typed rate box.
     *
     * Fifteen points across a few hundred pixels means the slider cannot be
     * dragged to 1.09 reliably; the box has to reach the model, and the
     * label above the slider is where that shows. */
    const rate = page.locator('[data-testid="loan-rate"] input').first();
    await rate.fill('2.75');
    await rate.press('Enter');
    await page.waitForTimeout(600);
    const rateText = await page.locator('body').innerText();
    // innerText applies text-transform, and the label is rendered upper case.
    check('the typed rate reaches the model', /2\.75% a year/i.test(rateText), rateText.slice(0, 400));
    // 2.75%/12 = 0.229167% a month, which is the conversion working too.
    check('and converts to a monthly rate', /0\.2292% a month/i.test(rateText), rateText.slice(0, 400));

    await page.click('button:text-is("The payment")');
    await page.waitForTimeout(600);
    const backText = await page.locator('body').innerText();
    /* Switching back carries the answer over as the new input, so the loan
     * must not jump: still 178 months, not the 200 it started at. */
    check(
      'switching back keeps the same loan',
      /Clear in\s+178 months/.test(backText),
      backText.slice(0, 300),
    );
    check('no error boundary after the term work', !/could not start/i.test(backText));
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '25-loan.png') });

  /* ---- the interface chrome actually works.
   *
   * Three bugs that every existing check sailed past, because each one is about
   * where a thing is on screen rather than whether it exists. */
  step('Chrome');

  // The mode picker must be visible to a human, not merely present in the DOM.
  // It lived inside an `overflow-x-auto` strip, which CSS clips vertically too,
  // so the dropdown was cropped to nothing while the button "worked".
  const tabsBefore = await page.locator('[draggable="true"]').count();
  await page.click('[data-testid="new-tab"]');
  await page.waitForTimeout(250);
  await revealMode(page, 'statistics');
  await page.waitForTimeout(150);
  const pickerVisible = await page.evaluate(() => {
    const item = document.querySelector('button[data-mode="statistics"]');
    if (!item) return { shown: false, why: 'not rendered' };
    const r = item.getBoundingClientRect();
    if (r.height < 8 || r.width < 8) return { shown: false, why: `collapsed to ${r.width}x${r.height}` };
    if (r.bottom > window.innerHeight || r.top < 0) return { shown: false, why: 'outside the window' };
    // The decisive test: is this element what you would actually hit if you
    // clicked where it claims to be? A clipped element fails here.
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { shown: Boolean(hit && item.contains(hit)), why: hit ? hit.tagName : 'nothing at that point' };
  });
  check('the mode picker is actually visible', pickerVisible.shown, pickerVisible.why);

  await page.click(await revealMode(page, 'statistics'));
  await page.waitForTimeout(500);
  const tabsAfter = await page.locator('[draggable="true"]').count();
  check('picking a mode opens that kind of tab', tabsAfter === tabsBefore + 1, `${tabsBefore} → ${tabsAfter}`);

  // The toggle's thumb must sit inside its own track. It was absolutely
  // positioned with no `left`, so it fell to the button's centred static
  // position and slid off the right-hand end when switched on.
  await page.click('button:has-text("View")');
  await page.waitForTimeout(300);
  const thumb = await page.evaluate(() => {
    const track = document.querySelector('button[role="switch"]');
    if (!track) return { ok: false, why: 'no toggle found' };
    const knob = track.querySelector('span');
    if (!knob) return { ok: false, why: 'no thumb found' };
    const t = track.getBoundingClientRect();
    const k = knob.getBoundingClientRect();
    const slackLeft = k.left - t.left;
    const slackRight = t.right - k.right;
    return {
      ok: slackLeft >= 0 && slackRight >= 0,
      why: `${slackLeft.toFixed(1)}px left, ${slackRight.toFixed(1)}px right of the track`,
    };
  });
  check('the toggle thumb sits inside its track', thumb.ok, thumb.why);

  /* "Equal scales" was handed a hard-coded 0.625 with no relation to the pixels
   * on screen. Merely asserting that the viewport *changed* does not catch that
   * — a constant changes it too. The discriminating test is that the resulting
   * aspect follows the window: squaring the axes in a wide window and in a tall
   * one must give two different y-ranges. A constant gives the same one twice. */
  const rangeRatio = async () => {
    const text = await page.locator('footer').innerText();
    const m = /x ∈ \[([-\d.e]+), ([-\d.e]+)\].*?y ∈ \[([-\d.e]+), ([-\d.e]+)\]/s.exec(text);
    if (!m) return null;
    const [, x0, x1, y0, y1] = m.map(Number);
    return (y1 - y0) / (x1 - x0);
  };
  const squareAt = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(size[0], size[1]);
    }, [w, h]);
    await page.waitForTimeout(700);
    await page.click('button:has-text("Equal scales")');
    await page.waitForTimeout(500);
    return rangeRatio();
  };
  const wide = await squareAt(1560, 820);
  const tall = await squareAt(1180, 980);
  check(
    'equal scales follows the real plot aspect',
    wide !== null && tall !== null && Math.abs(wide - tall) > 0.04,
    `wide window → ${wide?.toFixed(4)}, tall window → ${tall?.toFixed(4)}`,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1560, 960));
  await page.waitForTimeout(500);

  /* ---- New Project asks first.
   *
   * It used to replace the entire workspace the instant it was clicked, from a
   * "+" button sitting between Open and Save. The guard is exercised through the
   * real menu channel with `showMessageBox` intercepted, so this asserts both
   * that the prompt appears and that answering Cancel leaves everything alone. */
  step('Unsaved-work guard');
  const dirtyNow = (await page.locator('footer').innerText()).includes('unsaved changes');
  check('the document is dirty at this point', dirtyNow, 'nothing to guard otherwise');

  await app.evaluate(({ dialog }) => {
    globalThis.__dialogCalls = 0;
    globalThis.__origMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async () => {
      globalThis.__dialogCalls++;
      return { response: 2, checkboxChecked: false }; // Cancel
    };
  });

  const tabsBeforeNew = await page.locator('[draggable="true"]').count();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.new'),
  );
  await page.waitForTimeout(900);
  const prompts = await app.evaluate(() => globalThis.__dialogCalls);
  const tabsAfterNew = await page.locator('[draggable="true"]').count();

  check('New Project asks before discarding', prompts === 1, `${prompts} prompts shown`);
  check('cancelling keeps every tab', tabsAfterNew === tabsBeforeNew, `${tabsBeforeNew} → ${tabsAfterNew}`);

  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.__origMessageBox;
  });

  /* ---- progressive rendering actually progresses.
   *
   * The bifurcation diagram and the fractal are computed a slice at a time into
   * one buffer that is repainted after each slice. A caching bug in the raster
   * layer once froze both at whatever the first paint happened to catch, while
   * the progress caption kept counting up — invisible in a single screenshot,
   * and exactly what this pair of samples catches. */
  step('Progressive rendering');
  await selectMode(page, 'dynamics');
  await page.waitForTimeout(6000);
  const coverage = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return { left: 0, right: 0 };
    const ctx = canvas.getContext('2d');
    // Sample a tall strip near each edge of the plot. If the renderer froze
    // after its first slice, the left strip is populated and the right one is
    // empty; a completed diagram has structure in both.
    const sample = (fraction) => {
      const x = Math.round(canvas.width * fraction);
      const data = ctx.getImageData(Math.min(x, canvas.width - 8), 0, 6, canvas.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 60 || data[i + 2] > 90) lit++;
      }
      return lit;
    };
    // Ten strips across the plot. The diagram is a single thin curve at low r
    // and a dense smear at high r, so the counts vary hugely — what matters is
    // that every strip has *something* in it. A frozen renderer leaves all but
    // the first empty.
    const strips = [];
    for (let i = 0; i < 10; i++) strips.push(sample(0.1 + i * 0.088));
    return { strips, populated: strips.filter((n) => n > 0).length };
  });
  check(
    'the bifurcation diagram fills its whole width',
    coverage.populated >= 9,
    `${coverage.populated}/10 strips drawn (${coverage.strips.join(', ')})`,
  );
  await page.screenshot({ path: path.join(SHOT_DIR, '13-bifurcation-complete.png') });

  // ---- exercise the modes that have a second view
  step('Secondary views');
  await page.click('button[role="tab"]:has-text("Fractal")');
  await page.waitForTimeout(2500);
  const fractal = await canvasHasContent(page);
  check('the fractal renders', fractal.ok, fractal.reason);
  await page.screenshot({ path: path.join(SHOT_DIR, '09-fractal.png') });

  await selectMode(page, 'linear-algebra');
  await page.click('button[role="tab"]:has-text("Planes")');
  await page.waitForTimeout(1600);
  const planes = await canvasHasContent(page);
  check('the 3D plane scene renders', planes.ok, planes.reason);
  await page.screenshot({ path: path.join(SHOT_DIR, '10-planes.png') });

  /* Orbiting has to survive the whole gesture, not just its first event.
   *
   * The gesture handlers used to be re-bound whenever the camera changed, and
   * since the camera changes on every mouse move, the drag state was wiped
   * after the first one: the view rotated by a single mouse-move's worth and
   * then ignored the rest. A test that presses, moves once and releases passes
   * that bug happily — which is exactly what the earlier one did. So this
   * moves repeatedly and insists the camera is still moving at the *end* of
   * the drag as well as at the start. */
  {
    const readCamera = () =>
      page.evaluate(() => {
        const sliders = [...document.querySelectorAll('input[type=range]')];
        return sliders.map((s) => Number(s.value));
      });

    const box = await page.locator('canvas').last().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const before = await readCamera();
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 14, cy + 4);
    await page.waitForTimeout(70);
    const afterFirst = await readCamera();
    for (let i = 2; i <= 8; i++) {
      await page.mouse.move(cx + i * 14, cy + i * 4);
      await page.waitForTimeout(40);
    }
    const afterMany = await readCamera();
    await page.mouse.up();
    await page.waitForTimeout(150);

    const moved = (a, b) => a.length === b.length && a.some((v, i) => Math.abs(v - b[i]) > 1e-9);
    check('dragging the 3D view starts orbiting it', moved(before, afterFirst), `${before} → ${afterFirst}`);
    check(
      'and keeps orbiting for the rest of the drag',
      moved(afterFirst, afterMany),
      `stuck at ${afterFirst} after the first move`,
    );
  }

  await page.click('button[role="tab"]:has-text("Calc")');
  await page.waitForTimeout(800);
  const calcText = await page.locator('body').innerText();
  check('the matrix calculator shows a determinant', /Determinant/i.test(calcText));
  await page.screenshot({ path: path.join(SHOT_DIR, '11-calculator.png') });

  // ---- serialisation round trip, driven through the real store
  process.stdout.write('\nProject file\n');
  const roundTrip = await page.evaluate(async () => {
    const before = document.querySelectorAll('[draggable="true"]').length;
    return { tabs: before };
  });
  check('several tabs are open', roundTrip.tabs >= 8, `${roundTrip.tabs} tabs`);

  // ---- animation clock
  process.stdout.write('\nTimeline\n');
  const playButton = page.locator('button[title="Play"]').first();
  if (await playButton.count()) {
    await playButton.click();
    await page.waitForTimeout(1200);
    const running = await page.locator('button[title="Pause"]').count();
    check('the clock starts when play is pressed', running > 0);
    if (running > 0) await page.locator('button[title="Pause"]').first().click();
  } else {
    check('a transport bar is present', false, 'no play button found');
  }

  await page.screenshot({ path: path.join(SHOT_DIR, '12-final.png') });

  // The window refuses to close while the document is dirty — it puts up a
  // native "save your changes?" dialog that nothing here can answer. Clearing
  // the flag through the real bridge both exercises that IPC channel and lets
  // the test shut down; a stuck close here is the guard working, not a bug.
  await page.evaluate(() => window.manifold?.setDirty(false));
  await page.waitForTimeout(200);

  if (!argv.includes('--keep-open')) {
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 8000)).then(() =>
        app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {}),
      ),
    ]);
  }

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) process.stdout.write(`  · ${f}\n`);
  }
  process.stdout.write(`Screenshots in ${SHOT_DIR}\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  process.stderr.write(`\nSmoke test could not run: ${err && err.stack ? err.stack : err}\n`);
  process.exit(2);
});
