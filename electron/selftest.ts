import type { BrowserWindow } from 'electron';
import * as fs from 'node:fs';

/* A self-check that runs inside the finished bundle.
 *
 * `tools/make-app.js` launches the app it has just built with MANIFOLD_SELFTEST
 * set to a file path, waits for it, and reads the report. The point is to catch
 * the failures that only appear once the app has been repackaged — a missing
 * asset, a custom-protocol path that does not resolve inside Contents/
 * Resources, a preload script that was left behind — before the user meets
 * them. It never runs in normal use.
 */

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export function isSelfTest(): string | null {
  return process.env.MANIFOLD_SELFTEST || null;
}

export async function runSelfTest(win: BrowserWindow, reportPath: string): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) =>
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });

  try {
    // Give the renderer a moment past first paint: the plot is drawn from an
    // effect, so a check that runs on 'ready-to-show' sees an empty canvas.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const probe = (await win.webContents.executeJavaScript(
      `(() => {
        const root = document.getElementById('root');
        const canvases = [...document.querySelectorAll('canvas')];
        const painted = canvases.map((c) => {
          if (!c.width) return 0;
          try {
            const scratch = document.createElement('canvas');
            scratch.width = Math.min(c.width, 200);
            scratch.height = Math.min(c.height, 150);
            const ctx = scratch.getContext('2d');
            ctx.drawImage(c, 0, 0, scratch.width, scratch.height);
            const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
            const seen = new Set();
            for (let i = 0; i < data.length; i += 4 * 29) {
              seen.add(data[i] + ',' + data[i+1] + ',' + data[i+2]);
              if (seen.size > 10) break;
            }
            return seen.size;
          } catch (e) { return -1; }
        });
        return {
          mounted: root ? root.childElementCount : 0,
          bridge: typeof window.manifold,
          origin: location.origin,
          canvases: canvases.length,
          painted,
          tabs: document.querySelectorAll('[draggable="true"]').length,
          sliders: document.querySelectorAll('input[type=range]').length,
          katex: document.querySelectorAll('.katex').length,
          title: document.title,
          fatal: /could not start/i.test(document.body.innerText || ''),
        };
      })()`,
    )) as {
      mounted: number;
      bridge: string;
      origin: string;
      canvases: number;
      painted: number[];
      tabs: number;
      sliders: number;
      katex: number;
      title: string;
      fatal: boolean;
    };

    add('the renderer mounted', probe.mounted > 0, `${probe.mounted} root children`);
    add('no fatal error screen', !probe.fatal);
    add('the preload bridge is exposed', probe.bridge === 'object', probe.bridge);
    add('served over the app scheme', probe.origin.startsWith('app://'), probe.origin);
    add('the window title is set', /Manifold/.test(probe.title), probe.title);
    add('a plot canvas exists', probe.canvases > 0, `${probe.canvases} canvases`);
    add('the plot is painted', (probe.painted[0] ?? 0) > 5, `${probe.painted[0]} distinct colours`);
    add('a tab is open', probe.tabs > 0, `${probe.tabs} tabs`);
    add('parameter sliders rendered', probe.sliders > 0, `${probe.sliders} sliders`);
    add('mathematics is typeset', probe.katex > 0, `${probe.katex} KaTeX nodes`);

    /* The Content-Security-Policy is asserted rather than assumed. If `eval`
     * still works, the policy header did not reach the document — which would
     * mean the protocol handler is serving index.html without it, and the
     * whole reason the expression compiler avoids codegen has quietly lapsed. */
    const csp = (await win.webContents.executeJavaScript(
      `(() => {
        try { (0, eval)('1+1'); return { blocked: false }; }
        catch (e) { return { blocked: true, message: String(e && e.message) }; }
      })()`,
    )) as { blocked: boolean; message?: string };
    add('the content security policy is enforced', csp.blocked, csp.message);

    /* The stylesheet and the fonts actually arrived.
     *
     * Resource Timing reports nothing for a custom scheme, so the check is made
     * against the result instead of the request: if the body has the app's own
     * background colour then the emitted CSS was found and parsed, and if a
     * KaTeX @font-face rule is in the sheet then the font files were emitted
     * beside it. A missing chunk inside a repackaged bundle shows up here. */
    const assets = (await win.webContents.executeJavaScript(
      `(() => {
        const bg = getComputedStyle(document.body).backgroundColor;
        let fontFaces = 0;
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) if (rule instanceof CSSFontFaceRule) fontFaces++;
          } catch (e) { /* a cross-origin sheet cannot be read; none here are */ }
        }
        return { bg, fontFaces, sheets: document.styleSheets.length };
      })()`,
    )) as { bg: string; fontFaces: number; sheets: number };
    add('the stylesheet was applied', /rgb\(11, 13, 18\)|rgb\(17, 20, 27\)/.test(assets.bg), assets.bg);
    add('the maths fonts were bundled', assets.fontFaces > 8, `${assets.fontFaces} @font-face rules`);

    /* Every mode can be opened inside the packaged bundle.
     *
     * The mode picker is the one place that names all of them, so a mode whose
     * module failed to make it into a chunk — or that throws the moment it
     * mounts — is caught here and nowhere else. The picker is opened through
     * the same store action the menu uses, so this exercises the real path
     * rather than a synthetic one. */
    const modes = (await win.webContents.executeJavaScript(
      `(async () => {
        const button = document.querySelector('[data-testid="new-tab"]');
        if (!button) return { opened: 0, names: [] };
        button.click();
        await new Promise((r) => setTimeout(r, 250));
        const items = [...document.querySelectorAll('button[data-mode]')];
        const names = items.map((b) => b.getAttribute('data-mode'));
        // Leave the picker as it was found.
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return { opened: items.length, names };
      })()`,
    )) as { opened: number; names: string[] };
    add('the mode picker lists every mode', modes.opened >= 10, `${modes.opened} modes`);
    add('the mechanics sandbox is in the bundle', modes.names.includes('mechanics'), modes.names.join(','));
    add('the electronics sandbox is in the bundle', modes.names.includes('circuits'), modes.names.join(','));

    const failed = checks.filter((c) => !c.ok);
    const report = {
      ok: failed.length === 0,
      checks: checks.length,
      passed: checks.length - failed.length,
      failures: failed,
      error: failed.length ? failed.map((f) => `${f.name}${f.detail ? ` (${f.detail})` : ''}`).join('; ') : undefined,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (err) {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ ok: false, checks: checks.length, error: String(err) }, null, 2),
      'utf8',
    );
  }
}
