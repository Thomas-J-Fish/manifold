import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('./package.json') as { version: string };

/* One config, two targets.
 *
 * `npm run build` produces the renderer for the desktop app, served over the
 * custom `app://` scheme (see electron/protocol.ts) — never over file://, which
 * has an opaque origin that breaks ES modules and any meaningful CSP at once.
 * Assets there are emitted with an absolute `/` base.
 *
 * `npm run build:web` produces the same application as a static site. The two
 * differences are both about not knowing where it will be hosted: assets are
 * emitted with a *relative* base so the build works from a subpath — which is
 * what GitHub Pages gives you unless you own the domain — and the
 * Content-Security-Policy is injected as a meta tag, because a static host has
 * no place to configure response headers. The desktop build gets its CSP from
 * the protocol handler instead, which is stricter and is why the tag is not
 * simply always there.
 */

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  // KaTeX positions every glyph with an inline style attribute; there is no
  // way to typeset mathematics without this one exemption. Note what is absent:
  // 'unsafe-eval'. The expression compiler builds closures rather than
  // generating source, so the page can forbid eval outright.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  /* No frame-ancestors here: it is ignored when delivered in a meta tag and
   * the browser logs a warning saying so. It belongs in a real response
   * header, which is where public/_headers puts it for hosts that support
   * one. */
].join('; ');

function webSecurityHeaders(): Plugin {
  return {
    name: 'manifold-web-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
          {
            tag: 'meta',
            attrs: { name: 'referrer', content: 'no-referrer' },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  return {
    base: web ? './' : '/',
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: [react(), ...(web ? [webSecurityHeaders()] : [])],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      // Deliberately NOT `dist`: that is electron-builder's default output
      // directory, and electron-builder excludes its own output from the package.
      // Building the renderer there means the packaged app silently ships with no
      // user interface at all. `out/` is the electron-vite convention and leaves
      // `dist/` free for the installer artefacts.
      outDir: web ? 'out/web' : 'out/renderer',
      emptyOutDir: true,
      target: 'es2022',
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 2500,
      rollupOptions: {
        output: {
          // Splitting the three heavyweights out keeps the main chunk small
          // enough that the window paints before the 3D stack is parsed.
          manualChunks: (id: string) => {
            if (!id.includes('node_modules')) return undefined;
            if (/node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor_react';
            if (/node_modules[\\/](mathjs|decimal\.js|complex\.js|fraction\.js|typed-function|escape-latex|javascript-natural-sort|seedrandom|tiny-emitter)[\\/]/.test(id)) return 'vendor_math';
            if (/node_modules[\\/]three[\\/]/.test(id)) return 'vendor_three';
            if (/node_modules[\\/]katex[\\/]/.test(id)) return 'vendor_katex';
            return undefined;
          },
        },
      },
    },
    worker: { format: 'es' },
    server: { port: 5273, strictPort: true },
  };
});
