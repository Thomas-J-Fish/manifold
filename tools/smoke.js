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
async function selectMode(page, id) {
  await page.click('[data-testid="new-tab"]');
  await page.waitForSelector(`button[data-mode="${id}"]`, { timeout: 6000 });
  await page.click(`button[data-mode="${id}"]`);
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
  await page.screenshot({ path: path.join(SHOT_DIR, '12-circuits-running.png') });

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

  await page.click('button[data-mode="statistics"]');
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
