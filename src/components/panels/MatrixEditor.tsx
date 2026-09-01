import { NumberField } from '../ui/controls';

/** A grid of number inputs with the bracket rules drawn around it. */
export function MatrixEditor({
  matrix,
  onChange,
  labels,
  disabled,
}: {
  matrix: number[][];
  onChange: (m: number[][]) => void;
  labels?: string[];
  disabled?: boolean;
}) {
  const set = (i: number, j: number, v: number) => {
    const next = matrix.map((row) => [...row]);
    next[i][j] = v;
    onChange(next);
  };

  return (
    <div className="flex items-stretch gap-1">
      <Bracket side="left" />
      <div className="flex-1 space-y-1">
        {labels && (
          <div className="flex gap-1">
            {labels.map((l) => (
              <span key={l} className="flex-1 text-center text-2xs text-ink-faint">
                {l}
              </span>
            ))}
          </div>
        )}
        {matrix.map((row, i) => (
          <div key={i} className="flex gap-1">
            {row.map((value, j) => (
              <NumberField
                key={j}
                className="flex-1"
                value={value}
                step={0.1}
                precision={4}
                disabled={disabled}
                onChange={(v) => set(i, j, v)}
              />
            ))}
          </div>
        ))}
      </div>
      <Bracket side="right" />
    </div>
  );
}

function Bracket({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      className={`w-1.5 shrink-0 rounded-sm border-y border-edge-strong ${
        side === 'left' ? 'border-l' : 'border-r'
      }`}
      aria-hidden="true"
    />
  );
}

/** A read-only matrix, formatted for the results panels. */
export function MatrixDisplay({
  matrix,
  digits = 4,
  highlight,
}: {
  matrix: number[][];
  digits?: number;
  highlight?: (i: number, j: number) => boolean;
}) {
  return (
    <div className="flex items-stretch gap-1">
      <Bracket side="left" />
      <div className="flex-1">
        {matrix.map((row, i) => (
          <div key={i} className="flex">
            {row.map((v, j) => (
              <span
                key={j}
                className={`flex-1 px-1 py-0.5 text-right font-mono text-xs tabular-nums ${
                  highlight?.(i, j) ? 'rounded bg-accent/20 text-accent-soft' : 'text-ink'
                }`}
              >
                {format(v, digits)}
              </span>
            ))}
          </div>
        ))}
      </div>
      <Bracket side="right" />
    </div>
  );
}

function format(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '—';
  // Values that are integers to within rounding noise are shown as integers:
  // elimination produces 0.9999999999999998 constantly and printing that
  // makes an exact answer look approximate.
  const rounded = Number(v.toFixed(digits));
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) return String(Math.round(rounded));
  return String(rounded);
}
