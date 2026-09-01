import { protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* Why a custom scheme instead of file://
 * ---------------------------------------
 * A file:// document has an opaque origin. That single fact breaks three
 * things this app depends on: ES module scripts refuse to load, `new Worker`
 * with `{type:'module'}` is blocked, and a meaningful Content-Security-Policy
 * cannot be expressed because 'self' means nothing. Serving the built renderer
 * over a scheme registered as *standard* and *secure* gives the window a real
 * origin (app://manifold), so modules, workers, fetch and CSP all behave the
 * way they do on the web — while the handler below still only ever reads files
 * out of the app's own dist directory.
 */

export const SCHEME = 'app';
export const HOST = 'manifold';
export const ORIGIN = `${SCHEME}://${HOST}`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Must be called before `app.whenReady()`; Chromium reads the scheme
 *  registry once, during startup, and ignores anything added later. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Serves `rootDir` at app://manifold/. Any path that escapes the root, or does
 * not exist and does not look like a static asset, falls back to index.html so
 * the renderer's own routing keeps working.
 */
export function installHandler(rootDir: string): void {
  const root = path.resolve(rootDir);
  const indexFile = path.join(root, 'index.html');

  protocol.handle(SCHEME, async (request) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Normalising first, then re-checking containment, is what stops
    // `app://manifold/../../etc/passwd` from resolving outside dist.
    const candidate = path.resolve(root, '.' + path.posix.normalize(pathname));
    const inRoot = candidate === root || candidate.startsWith(root + path.sep);

    let file = inRoot ? candidate : indexFile;
    try {
      const st = await fs.promises.stat(file);
      if (st.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // Unknown extension-less paths are renderer routes; unknown asset paths
      // are genuine 404s and should say so rather than silently serving HTML.
      if (path.extname(file)) return new Response('Not found', { status: 404 });
      file = indexFile;
    }

    try {
      const body = await fs.promises.readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      const headers: Record<string, string> = {
        'Content-Type': type,
        // Hashed asset names make immutable caching safe; index.html is not
        // hashed, so it must never be cached or updates would not take.
        'Cache-Control': file === indexFile ? 'no-cache' : 'public, max-age=31536000, immutable',
      };
      // The policy is a header rather than a <meta> tag so it applies only to
      // the packaged app; the Vite dev server needs a websocket for HMR that
      // this would otherwise forbid. `unsafe-inline` is granted to styles
      // alone, because KaTeX positions every glyph with a style attribute.
      // Scripts get no such exemption, which is the reason the expression
      // compiler builds closures instead of calling `new Function`.
      if (type.startsWith('text/html')) {
        headers['Content-Security-Policy'] = [
          "default-src 'none'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self'",
          "worker-src 'self' blob:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
          "object-src 'none'",
        ].join('; ');
      }
      // A Uint8Array view over the buffer: `Response` accepts it directly, and
      // it avoids naming DOM's `BodyInit` type, which the main process's
      // Node-only lib set does not declare.
      return new Response(new Uint8Array(body), { status: 200, headers });
    } catch (err) {
      return new Response(`Failed to read ${path.basename(file)}: ${String(err)}`, { status: 500 });
    }
  });
}
