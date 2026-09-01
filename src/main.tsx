import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Manifold could not find its mount point.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/* A last line of defence.
 *
 * A numerical bug in a plot builder should cost the user their plot, not their
 * whole session — but React will unmount the tree on an uncaught render error
 * and the window would go blank with no explanation. These handlers put a
 * readable message on screen instead, with enough detail to report.
 */
window.addEventListener('error', (event) => reportFatal(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportFatal(event.reason));

let reported = false;
function reportFatal(error: unknown): void {
  if (reported) return;
  const root = document.getElementById('root');
  if (!root || root.childElementCount > 0) return; // the app is still rendering fine
  reported = true;
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);
  root.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.style.cssText =
    'padding:48px;font:13px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#e6e9f2;max-width:70ch;';
  const heading = document.createElement('h1');
  heading.textContent = 'Manifold could not start';
  heading.style.cssText = 'font-size:15px;margin:0 0 12px;font-weight:600;';
  const body = document.createElement('p');
  body.textContent = 'Something went wrong before the interface could render. The details are below.';
  body.style.cssText = 'margin:0 0 16px;color:#9aa3b8;';
  const pre = document.createElement('pre');
  pre.textContent = message;
  pre.style.cssText =
    'white-space:pre-wrap;background:#171b24;border:1px solid #2b3243;border-radius:8px;padding:12px;font-size:11px;color:#9aa3b8;overflow:auto;max-height:50vh;';
  wrapper.append(heading, body, pre);
  root.append(wrapper);
}
