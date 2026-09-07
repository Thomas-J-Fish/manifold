#!/usr/bin/env node
'use strict';
/* Screenshots one mode of the web build, for looking at.
 *
 * The unit tests assert against closed forms and the smoke tests assert the
 * app works; neither can tell that a circle is being drawn as an ellipse, that
 * a ground symbol is on its side, or that a formula has rendered as red LaTeX
 * source. Four real bugs in this project were found by looking at a picture,
 * so taking one needs to be a single command.
 *
 *   node tools/shot.js circuits --play 3 --out shots/rc.png
 *   node tools/shot.js graphing --kind polar --expression "2(1+cos(theta))"
 *
 * Requires the web build (npm run build:web). MANIFOLD_CHROMIUM points at a
 * browser binary if Playwright's own is not installed.
 */

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'out', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'graphing';
const out = path.resolve(flag('out', path.join(ROOT, 'test-shots', `${mode}.png`)));
const play = Number(flag('play', 0));
const port = Number(flag('port', 4182));

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(WEB, decodeURIComponent(url.pathname));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

(async () => {
  if (!fs.existsSync(path.join(WEB, 'index.html'))) {
    process.stderr.write('No web build found. Run: npm run build:web\n');
    process.exit(1);
  }
  const server = await serve();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-gpu'],
    executablePath: process.env.MANIFOLD_CHROMIUM || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(`http://localhost:${port}/`);
  await page.waitForSelector('canvas');

  /* --example loads one of the worked examples by id, which is the only way to
   * see what a user actually sees when they pick one: the example's own
   * viewport, its parameters and its clock, none of which a fresh tab has. */
  const example = flag('example');
  if (example) {
    await page.click('button[data-menu="Help"]');
    await page.click('button[data-command="help.examples"]');
    await page.waitForSelector('[data-example-group]', { timeout: 8000 });
    /* The groups are collapsed, and only one opens at a time, so try each in
     * turn until the wanted example appears rather than working out which mode
     * it belongs to. */
    const target = page.locator(`button[data-example="${example}"]`);
    const groups = await page.locator('[data-example-group]').all();
    let found = false;
    for (const group of groups) {
      await group.click();
      await page.waitForTimeout(120);
      if ((await target.count()) > 0) {
        found = true;
        break;
      }
    }
    if (!found) {
      process.stderr.write(`No example with id "${example}".\n`);
      process.exit(1);
    }
    await target.click();
    await page.waitForTimeout(1400);
  } else if (mode !== 'graphing') {
    await page.click('[data-testid="new-tab"]');
    /* Two-level picker: a subject, then the modes inside it. Only one subject
     * is open at a time, so open each heading in turn until the mode appears
     * rather than teaching this tool which subject each mode lives in. */
    const button = `button[data-mode="${mode}"]`;
    if (!(await page.locator(button).count())) {
      for (const category of await page.locator('[data-category]').all()) {
        await category.click();
        await page.waitForTimeout(80);
        if (await page.locator(button).count()) break;
      }
    }
    await page.waitForSelector(button, { timeout: 8000 });
    await page.click(button);
    await page.waitForTimeout(1000);
  }

  // --button clicks a control by its visible text, which is how the mode's own
  // view switchers are reached without teaching this tool their markup.
  for (const label of argv.filter((a, i) => argv[i - 1] === '--button')) {
    // Any clickable with that exact text: the segmented controls are tabs, the
    // palettes are buttons, and this tool should not have to know which.
    await page.locator(`button:text-is("${label}"), [role="tab"]:text-is("${label}")`).first().click();
    await page.waitForTimeout(1200);
  }

  const kind = flag('kind');
  if (kind) await page.selectOption('select', kind);
  const expression = flag('expression');
  if (expression) {
    const input = page.locator('input[type="text"]').first();
    await input.fill(expression);
    await input.press('Enter');
  }

  if (play > 0) {
    // Space is the play/pause accelerator, but only when nothing has focus.
    await page.click('canvas', { position: { x: 20, y: 20 } });
    await page.keyboard.press('Space');
    await page.waitForTimeout(play * 1000);
  }
  await page.waitForTimeout(700);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  process.stdout.write(`wrote ${out}\n`);

  await browser.close();
  server.close();
})();
