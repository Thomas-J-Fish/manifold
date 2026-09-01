import type { AnalyticResult } from '../../core/physics/analytic';
import { Formula } from '../inputs/MathField';
import { fmt, Stat, StatList } from '../ui/controls';

/**
 * The "why" panel: what this arrangement is called, the equation that governs
 * it, and the numbers that fall out of it.
 *
 * It sits under the live plot rather than beside it deliberately. The reading
 * comes first and the theory second, which is the order the experiment happens
 * in — and it means a student who wants to predict the answer before running
 * it can collapse this and still see everything else.
 */
export function AnalyticCard({ result, collapsed }: { result: AnalyticResult; collapsed?: boolean }) {
  if (collapsed) return null;
  return (
    <div className="space-y-2.5 border-t border-edge px-3 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink">{result.title}</h3>
        <span className="text-2xs text-ink-faint">Governing equations</span>
      </div>

      {result.equations.length > 0 && (
        <div className="space-y-1 overflow-x-auto rounded-md border border-edge bg-surface-1 px-3 py-2.5">
          {result.equations.map((latex, i) => (
            <div key={i} className="text-center">
              <Formula latex={latex} display />
            </div>
          ))}
        </div>
      )}

      {result.quantities.length > 0 && (
        <StatList>
          {result.quantities.map((q) => (
            <Stat
              key={q.label}
              label={q.label}
              value={`${fmt(q.value, 5)}${q.unit ? ` ${q.unit}` : ''}`}
            />
          ))}
        </StatList>
      )}

      {result.caveat && (
        <p className="rounded-md border border-edge bg-surface-1 px-2.5 py-2 text-2xs leading-relaxed text-ink-dim">
          {result.caveat}
        </p>
      )}
    </div>
  );
}
