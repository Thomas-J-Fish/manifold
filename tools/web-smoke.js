#!/usr/bin/env node
'use strict';
/* End-to-end test of the *web* build.
 *
 * The desktop smoke test drives the Electron app; this one serves the static
 * site over plain HTTP and drives it in a browser, because everything that is
 * different about the web version — the in-page menu, the browser bridge, the
 * share link, the autosave, the Content-Security-Policy — only exists there.
 *
 * It serves over HTTP rather than opening the files directly, deliberately.
 * A file:// origin has no localStorage, no clipboard and no meaningful CSP, so
 * a test run that way would pass while the deployed site failed.
 *
 *   node tools/web-smoke.js [--shots <dir>] [--port <n>]
 *
 * Requires the web build: npm run build:web
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'out', 'web');
const argv = process.argv.slice(2);
const shotIndex = argv.indexOf('--shots');
const SHOT_DIR = shotIndex >= 0 ? path.resolve(argv[shotIndex + 1]) : path.join(ROOT, 'test-shots', 'web');
const portIndex = argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(argv[portIndex + 1]) : 4178;

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

const step = (name) => process.stdout.write(`\n${name}\n`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

/* A static server rather than `serve` or `http-server`: one fewer dependency to
 * install in CI, and it means the test controls the headers, which is how the
 * hosted copy will be configured. */
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file = path.join(WEB, decodeURIComponent(url.pathname));
      if (url.pathname === '/' || !fs.existsSync(file)) file = path.join(WEB, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function canvasHasContent(page, index = 0) {
  return page.evaluate((i) => {
    const canvas = document.querySelectorAll('canvas')[i];
    if (!canvas || canvas.width === 0) return { ok: false, reason: 'no canvas' };
    const scratch = document.createElement('canvas');
    scratch.width = Math.min(canvas.width, 400);
    scratch.height = Math.min(canvas.height, 300);
    const ctx = scratch.getContext('2d');
    ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    const seen = new Set();
    for (let p = 0; p < data.length; p += 4 * 37) {
      seen.add(`${data[p]},${data[p + 1]},${data[p + 2]}`);
      if (seen.size > 12) break;
    }
    return { ok: seen.size > 6, reason: `${seen.size} distinct colours` };
  }, index);
}

// Two-level picker: open subjects in turn until the mode's button appears.
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
  await page.waitForSelector(button, { timeout: 8000 });
  await page.click(button);
  await page.waitForTimeout(900);
}

async function main() {
  if (!fs.existsSync(path.join(WEB, 'index.html'))) {
    process.stderr.write('No web build found. Run: npm run build:web\n');
    process.exit(1);
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const server = await serve();
  const base = `http://localhost:${PORT}/`;
  /* MANIFOLD_CHROMIUM lets a machine whose installed browser build does not
   * match this Playwright version point at the one it does have, rather than
   * downloading a second copy. Unset, Playwright finds its own. */
  const executablePath = process.env.MANIFOLD_CHROMIUM || undefined;
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-gpu'],
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1500, height: 940 } });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`uncaught: ${err.message}`));

  await page.goto(base);
  await page.waitForSelector('#root > div', { timeout: 30000 });
  await page.waitForTimeout(1500);

  step('It loads at all');
  check('the page has a title', (await page.title()).includes('Manifold'));
  check('the app mounted', (await page.locator('#root > div').count()) === 1);
  check(
    'no Electron bridge is present, so the web one is in use',
    await page.evaluate(() => typeof window.manifold === 'undefined'),
  );
  const plot = await canvasHasContent(page);
  check('the graph is drawn', plot.ok, plot.reason);
  await page.screenshot({ path: path.join(SHOT_DIR, '01-loaded.png') });

  step('The in-page menu replaces the native one');
  await page.click('button[data-menu="File"]');
  await page.waitForSelector('button[data-command="file.share"]', { timeout: 4000 });
  const menuVisible = await page.locator('button[data-command="file.share"]').isVisible();
  check('a menu opens and its items are visible', menuVisible);
  const menuBox = await page.locator('button[data-command="file.share"]').boundingBox();
  check(
    'the menu is not clipped to nothing',
    !!menuBox && menuBox.height > 8 && menuBox.width > 40,
    menuBox ? `${menuBox.width.toFixed(0)}×${menuBox.height.toFixed(0)}` : 'no box',
  );
  await page.keyboard.press('Escape');

  // Hover-to-switch, the behaviour every real menu bar has.
  await page.click('button[data-menu="View"]');
  await page.hover('button[data-menu="Tab"]');
  await page.waitForTimeout(200);
  check(
    'hovering moves between menus once one is open',
    await page.locator('button[data-command="tab.duplicate"]').isVisible(),
  );
  await page.keyboard.press('Escape');

  step('Menu commands actually do things');
  const tabsBefore = await page.locator('[draggable="true"]').count();
  await page.click('button[data-menu="Tab"]');
  await page.click('button[data-command="tab.new"]');
  const mechanicsButton = await revealMode(page, 'mechanics');
  await page.waitForSelector(mechanicsButton, { timeout: 4000 });
  await page.click(mechanicsButton);
  await page.waitForTimeout(1200);
  check(
    'Tab → New Tab opens the mode picker and adds a tab',
    (await page.locator('[draggable="true"]').count()) === tabsBefore + 1,
  );
  const bench = await canvasHasContent(page);
  check('the mechanics sandbox renders in the browser', bench.ok, bench.reason);

  await page.click('button[data-menu="Help"]');
  await page.click('button[data-command="help.about"]');
  await page.waitForTimeout(400);
  const aboutText = await page.locator('body').innerText();
  check('Help → About opens, and knows it is on the web', /web ·/i.test(aboutText), aboutText.slice(0, 60));
  await page.keyboard.press('Escape');

  step('Every mode opens');
  for (const id of ['statistics', 'linear-algebra', 'monte-carlo', 'calculus', 'dynamics', 'fields', 'fitting', 'circuits', 'quantum', 'chemistry', 'waves', 'signals', 'optimisation', 'reactions', 'thermodynamics', 'geometry', 'loan']) {
    await selectMode(page, id);
    const result = await canvasHasContent(page);
    check(`${id} renders`, result.ok, result.reason);
  }
  await page.screenshot({ path: path.join(SHOT_DIR, '02-modes.png') });

  /* The two newest modes do the most arithmetic per frame, and the web build
   * is the one where a missing polyfill or a stripped worker would show. Check
   * a number from each rather than only that a canvas has pixels on it. */
  step('The new modes compute, not merely render');
  await selectMode(page, 'waves');
  await page.waitForTimeout(900);
  const wavesText = await page.locator('body').innerText();
  check(
    'waves: the speed is √(T/µ) = 63.246 m/s',
    /Wave speed\s+63\.24/.test(wavesText),
    wavesText.slice(0, 200),
  );
  await selectMode(page, 'signals');
  await page.waitForTimeout(1100);
  const signalsText = await page.locator('body').innerText();
  check('signals: Nyquist is half the sample rate', /Nyquist\s+500 Hz/.test(signalsText), signalsText.slice(0, 200));
  /* The peak list is what proves the FFT ran rather than that a panel drew:
   * the default signal is sin(2π·50t) + ½sin(2π·120t), so both frequencies
   * have to come back with the second half the height of the first. */
  const webPeaks = [...signalsText.matchAll(/([\d.]+) Hz\s+([\d.]+)\s/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const fifty = webPeaks.find((p) => Math.abs(p[0] - 50) < 1.5);
  const oneTwenty = webPeaks.find((p) => Math.abs(p[0] - 120) < 1.5);
  check(
    'signals: the FFT found both tones at the right relative amplitude',
    fifty && oneTwenty && Math.abs(oneTwenty[1] / fifty[1] - 0.5) < 0.08,
    fifty && oneTwenty
      ? `${fifty.join(' Hz @ ')} · ${oneTwenty.join(' Hz @ ')}`
      : signalsText.replace(/\s+/g, ' ').slice(0, 900),
  );

  /* And the three newest ones, each checked by a number that only comes out
   * right if the simulation behind it actually ran in this build. */
  await selectMode(page, 'optimisation');
  await page.waitForTimeout(1100);
  const optText = await page.locator('body').innerText();
  check(
    'optimisation: the simplex reaches 21 at (3, 1.5)',
    /Status\s+optimal/.test(optText) && /Objective\s+21\b/.test(optText),
    optText.slice(0, 300),
  );

  await selectMode(page, 'reactions');
  await page.waitForTimeout(1400);
  const rxnText = await page.locator('body').innerText();
  // A → B → C for 25 s at k₁ = 0.5: [A] must be down to about 4×10⁻⁶.
  const finalA = /\[A\] final\s+([\d.eE+-]+)/.exec(rxnText);
  check(
    'reactions: the network integrated to completion',
    finalA && Number(finalA[1]) < 1e-4,
    finalA ? finalA[1] : rxnText.slice(0, 300),
  );

  await selectMode(page, 'thermodynamics');
  await page.waitForTimeout(1600);
  const gasText = await page.locator('body').innerText();
  // In two dimensions T = ⟨mv²⟩/2k, and the gas is seeded at exactly 1.
  const gasT = /Temperature\s+([\d.]+)/.exec(gasText);
  check(
    'thermodynamics: the gas measures the temperature it was seeded at',
    gasT && Math.abs(Number(gasT[1]) - 1) < 0.12,
    gasT ? gasT[1] : gasText.slice(0, 300),
  );

  step('The example catalogue');

  {
    /* Fifty-nine examples behind seventeen dropdowns. The thing worth
     * asserting is not that the dialog opens but that every mode has a group
     * with a usable number in it — a mode whose heading is there and whose
     * list is empty is exactly what an unnoticed regression looks like. */
    await page.click('button[data-menu="Help"]');
    await page.click('button[data-command="help.examples"]');
    await page.waitForSelector('[data-example-group]', { timeout: 8000 });

    /* Subjects first now, with the mode groups nested inside them — and only
     * one subject open at a time, so the modes have to be counted subject by
     * subject rather than all at once. */
    const categoryIds = await page.locator('[data-example-category]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-example-category')),
    );
    check('there is a group for every subject', categoryIds.length === 5, `${categoryIds.length} subjects`);
    check(
      'and no examples are on show before a subject is opened',
      (await page.locator('button[data-example]').count()) === 0,
      `${await page.locator('button[data-example]').count()} shown`,
    );

    let groups = 0;
    const thin = [];
    /* Toggles, not switches: Mathematics starts open, so clicking it blindly
     * closes it and the modes inside vanish. Open only what is shut. */
    const expand = async (selector) => {
      if ((await page.locator(selector).getAttribute('aria-expanded')) !== 'true') {
        await page.click(selector);
        await page.waitForTimeout(110);
      }
    };
    const collapse = async (selector) => {
      if ((await page.locator(selector).getAttribute('aria-expanded')) === 'true') {
        await page.click(selector);
        await page.waitForTimeout(60);
      }
    };

    for (const id of categoryIds) {
      await expand(`[data-example-category="${id}"]`);
      const modeIds = await page.locator('[data-example-group]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-example-group')),
      );
      groups += modeIds.length;
      check(
        `${id} has modes in it`,
        modeIds.length > 0,
        `${modeIds.length} modes`,
      );
      for (const mode of modeIds) {
        await expand(`[data-example-group="${mode}"]`);
        const shown = await page.locator('button[data-example]').count();
        if (shown < 3) thin.push(`${mode}:${shown}`);
        await collapse(`[data-example-group="${mode}"]`);
      }
    }
    check('there is a group for every mode', groups === 19, `${groups} groups`);
    check('every mode has at least three examples', thin.length === 0, thin.join(' '));

    // And one of them actually loads into a working tab.
    const before = await page.locator('[draggable="true"]').count();
    await page.click('[data-example-category="physics"]');
    await page.waitForTimeout(120);
    await page.click('[data-example-group="waves"]');
    await page.waitForTimeout(150);
    await page.click('button[data-example="grating"]');
    await page.waitForTimeout(1400);
    const after = await page.locator('[draggable="true"]').count();
    check('loading one opens a new tab', after === before + 1, `${before} → ${after}`);
    const grating = await page.locator('body').innerText();
    check('with the example built, not merely named', /Slits\s+6/.test(grating), grating.slice(0, 300));
    // λD/d = 550 nm × 2 m / 80 µm = 13.75 mm, computed from the aperture.
    check(
      'and its physics run',
      /Fringe spacing\s+13\.75 mm/.test(grating),
      grating.slice(0, 400),
    );
    check('no error boundary', !/could not start/i.test(grating));
  }
  

  await page.screenshot({ path: path.join(SHOT_DIR, '04-examples.png') });

  step('Autosave survives a reload');
  await page.click('button[data-menu="Tab"]');
  await page.click('button[data-command="tab.rename"]');
  // `tab.rename` uses window.prompt, which Playwright must answer.
  page.once('dialog', (d) => d.accept('Renamed by the smoke test'));
  await page.waitForTimeout(600);

  const beforeReload = await page.locator('[draggable="true"]').count();
  await page.waitForTimeout(1200); // let the debounced write land
  const stored = await page.evaluate(() => localStorage.getItem('manifold.session.v1'));
  check('the session was written to local storage', !!stored && stored.length > 100, `${stored?.length ?? 0} bytes`);

  await page.reload();
  await page.waitForSelector('#root > div', { timeout: 20000 });
  await page.waitForTimeout(1600);
  const afterReload = await page.locator('[draggable="true"]').count();
  check('every tab came back after a refresh', afterReload === beforeReload, `${beforeReload} → ${afterReload}`);
  const restoredText = await page.locator('body').innerText();
  check('and the app said so', /Picked up where you left off/i.test(restoredText));

  step('A share link carries the whole project');
  await page.click('button[data-menu="File"]');
  await page.click('button[data-command="file.share"]');
  await page.waitForSelector('[data-testid="share-url"]', { timeout: 6000 });
  const shareUrl = await page.inputValue('[data-testid="share-url"]');
  check('a link is produced', shareUrl.startsWith(base) && shareUrl.includes('#p='), shareUrl.slice(0, 60));
  check('and it is small enough to send', shareUrl.length < 30000, `${shareUrl.length} characters`);
  await page.screenshot({ path: path.join(SHOT_DIR, '03-share.png') });
  await page.keyboard.press('Escape');

  // Open it as a different person would: a clean browser with no local storage.
  const stranger = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const guest = await stranger.newPage();
  const guestErrors = [];
  guest.on('pageerror', (err) => guestErrors.push(err.message));
  await guest.goto(shareUrl);
  await guest.waitForSelector('#root > div', { timeout: 20000 });
  await guest.waitForTimeout(1800);
  const guestTabs = await guest.locator('[draggable="true"]').count();
  check('someone opening the link gets every tab', guestTabs === afterReload, `${afterReload} → ${guestTabs}`);
  const guestText = await guest.locator('body').innerText();
  check('and is told where it came from', /from a link/i.test(guestText));
  check(
    'the address bar is tidied so a refresh does not undo their work',
    !(await guest.evaluate(() => location.hash)).startsWith('#p='),
  );
  check('the shared project rendered', (await canvasHasContent(guest)).ok);
  check('no errors in the recipient’s tab', guestErrors.length === 0, guestErrors.join(' | ').slice(0, 120));
  await guest.screenshot({ path: path.join(SHOT_DIR, '04-shared-link.png') });
  await stranger.close();

  step('The unsaved-work guard');
  const dirtyDot = await page.locator('header span.text-accent').count();
  check('restored work is marked unsaved, because it is in no file', dirtyDot > 0);
  await page.click('button[data-menu="File"]');
  await page.click('button[data-command="file.new"]');
  await page.waitForTimeout(500);
  const guarded = await page.locator('[data-testid="discard-cancel"]').count();
  check('New Project asks before discarding', guarded === 1);
  const tabsAtPrompt = await page.locator('[draggable="true"]').count();
  await page.click('[data-testid="discard-cancel"]');
  await page.waitForTimeout(400);
  check(
    'cancelling keeps every tab',
    (await page.locator('[draggable="true"]').count()) === tabsAtPrompt,
  );

  await page.click('button[data-menu="File"]');
  await page.click('button[data-command="file.new"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="discard-discard"]');
  await page.waitForTimeout(800);
  check('discarding really does start over', (await page.locator('[draggable="true"]').count()) === 1);

  step('Console');
  const noisy = consoleErrors.filter((t) => !/favicon|manifest|Download the React DevTools/i.test(t));
  check('nothing was logged as an error', noisy.length === 0, noisy.join(' | ').slice(0, 200));

  /* Last, because probing the policy makes the browser log a refusal — which
   * is the test succeeding, and would otherwise fail the check above.
   *
   * Note what this is not: `page.evaluate(() => eval('1+1'))`. Playwright
   * evaluates through the debugging protocol, which is exempt from the page's
   * policy, so that version reports "eval works" on a perfectly locked-down
   * page. Inserting a script element is subject to the policy whoever created
   * the element, so if the inline script never runs the policy is real. */
  step('The Content-Security-Policy is real');
  check(
    'the policy is in the document',
    await page.evaluate(() => !!document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
  );
  const cspProbe = await page.evaluate(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    const script = document.createElement('script');
    script.textContent = 'window.__cspProbeRan = true;';
    document.head.appendChild(script);
    script.remove();
    // The violation event is dispatched asynchronously, so give it a turn.
    await new Promise((r) => setTimeout(r, 60));
    return { ran: window.__cspProbeRan === true, violations };
  });
  check('inline script is refused by the page policy', !cspProbe.ran);
  check(
    'and the browser reported the violation',
    cspProbe.violations.some((v) => v.startsWith('script-src')),
    cspProbe.violations.join(', ') || 'none reported',
  );

  await browser.close();
  server.close();

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failures.length) {
    process.stdout.write('Failures:\n');
    for (const f of failures) process.stdout.write(`  · ${f}\n`);
  }
  process.stdout.write(`Screenshots in ${SHOT_DIR}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
