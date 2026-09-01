import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* A ten-entry MRU list kept in userData. Deliberately a plain JSON file rather
 * than electron-store: one dependency fewer, and a corrupt file degrades to an
 * empty list rather than to a crash on startup. */

const MAX = 10;

function file(): string {
  return path.join(app.getPath('userData'), 'recents.json');
}

export function readRecents(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((p): p is string => typeof p === 'string' && fs.existsSync(p)).slice(0, MAX);
  } catch {
    return [];
  }
}

function write(list: string[]): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(list, null, 2), 'utf8');
  } catch {
    /* A read-only home directory should cost the user their MRU list, nothing more. */
  }
}

export function pushRecent(filePath: string): void {
  const abs = path.resolve(filePath);
  const next = [abs, ...readRecents().filter((p) => p !== abs)].slice(0, MAX);
  write(next);
  app.addRecentDocument?.(abs);
}

export function clearRecents(): void {
  write([]);
  app.clearRecentDocuments?.();
}
