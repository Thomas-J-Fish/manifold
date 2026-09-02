import { useMemo, useState } from 'react';
import { useStore } from '../../core/store';
import { unboundSymbols } from '../../modes/graphing';
import { BOUND_VARIABLES, type ExpressionItem, type ExpressionKind, type Parameter } from '../../core/types';
import { SERIES_COLOURS } from '../../core/types';
import { analyseExpression, MathField } from '../inputs/MathField';
import { Collapsible, IconButton, NumberField, Row, Select, Toggle } from '../ui/controls';
import { IconChevronDown, IconEye, IconEyeOff, IconPlus, IconTrash } from '../ui/Icons';

const KIND_OPTIONS: { value: ExpressionKind; label: string; prefix: string }[] = [
  { value: 'function', label: 'Function of x', prefix: 'y =' },
  { value: 'parametric', label: 'Parametric curve', prefix: 'x(t) =' },
  { value: 'polar', label: 'Polar curve', prefix: 'r(θ) =' },
  { value: 'implicit', label: 'Implicit relation', prefix: '0 =' },
  { value: 'inequality', label: 'Inequality region', prefix: '0 <' },
  { value: 'points', label: 'Point list', prefix: '·' },
  { value: 'definition', label: 'Definition', prefix: 'def' },
];

const PREFIX_BY_KIND = new Map(KIND_OPTIONS.map((k) => [k.value, k.prefix]));

export function ExpressionPanel({
  expressions,
  parameters,
  definitionErrors,
}: {
  expressions: ExpressionItem[];
  parameters: Parameter[];
  definitionErrors: Map<string, string>;
}) {
  const addExpression = useStore((s) => s.addExpression);
  const syncParameters = useStore((s) => s.syncParameters);

  /* Every symbol the scope can resolve for any expression: the clock, the
   * sliders, and the names of definitions. The plot variables are deliberately
   * absent, because whether `t` or `θ` means anything depends on the kind of
   * expression it appears in — see `missing` below. */
  const known = useMemo(() => {
    const set = new Set<string>(['time']);
    for (const p of parameters) set.add(p.name);
    for (const e of expressions) {
      if (e.kind !== 'definition') continue;
      const m = /^\s*([A-Za-z_]\w*)\s*\(/.exec(e.source);
      if (m) set.add(m[1]);
    }
    return set;
  }, [parameters, expressions]);

  /* Unbound symbols, offered as one-click sliders. The rule lives in
   * graphing.ts, where it is tested; treating every plot variable as
   * always-defined used to mean `y = θ` raised nothing and quietly evaluated
   * θ as zero. */
  const missing = useMemo(() => unboundSymbols(expressions, known), [expressions, known]);

  return (
    <Collapsible
      title={`Expressions${expressions.length ? ` · ${expressions.length}` : ''}`}
      actions={
        <IconButton title="Add an expression" onClick={() => addExpression('function')}>
          <IconPlus size={14} />
        </IconButton>
      }
    >
      <div className="space-y-2">
        {expressions.map((e, i) => (
          <ExpressionRow
            key={e.id}
            expression={e}
            index={i}
            known={known}
            definitionError={definitionErrors.get(e.id) ?? null}
          />
        ))}
      </div>

      {missing.length > 0 && (
        <button
          type="button"
          onClick={() => syncParameters(missing)}
          className="w-full rounded-md border border-accent-deep/60 bg-accent/10 px-2 py-1.5 text-2xs text-accent-soft transition-colors hover:bg-accent/20"
        >
          Add {missing.length === 1 ? 'a slider' : 'sliders'} for{' '}
          <span className="font-mono">{missing.join(', ')}</span>
        </button>
      )}

      <div className="flex gap-1.5">
        <button
          type="button"
          className="flex-1 rounded-md border border-dashed border-edge py-1.5 text-2xs text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-dim"
          onClick={() => addExpression('function')}
        >
          + Function
        </button>
        <button
          type="button"
          className="flex-1 rounded-md border border-dashed border-edge py-1.5 text-2xs text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-dim"
          onClick={() => addExpression('parametric')}
        >
          + Parametric
        </button>
        <button
          type="button"
          className="flex-1 rounded-md border border-dashed border-edge py-1.5 text-2xs text-ink-faint transition-colors hover:border-edge-strong hover:text-ink-dim"
          onClick={() => addExpression('definition', 'f(x) = ')}
        >
          + Definition
        </button>
      </div>
    </Collapsible>
  );
}

function ExpressionRow({
  expression,
  index,
  known,
  definitionError,
}: {
  expression: ExpressionItem;
  index: number;
  known: Set<string>;
  definitionError: string | null;
}) {
  const update = useStore((s) => s.updateExpression);
  const remove = useStore((s) => s.removeExpression);
  const [open, setOpen] = useState(false);

  /* What this row may refer to: everything the scope defines globally, plus
   * the variables its own kind binds. `x` is defined in a function of x and
   * nowhere else; the polar angle is defined in a polar curve and nowhere
   * else. Sharing one set across every kind is what let `r = 2(1+cos(theta))`
   * pass without comment and plot a circle. */
  const resolvable = useMemo(
    () => new Set([...known, ...BOUND_VARIABLES[expression.kind]]),
    [known, expression.kind],
  );

  const status = useMemo(() => {
    if (expression.kind === 'definition') {
      return {
        ok: !definitionError,
        latex: null,
        error: definitionError,
        detail: null,
        symbols: [],
      };
    }
    return analyseExpression(expression.source, resolvable);
  }, [expression.source, expression.kind, resolvable, definitionError]);

  const isParametric = expression.kind === 'parametric';
  const prefix = PREFIX_BY_KIND.get(expression.kind) ?? '';

  return (
    <div className="rounded-md border border-edge bg-surface-1 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <button
          type="button"
          title="Change the series colour"
          className="h-4 w-4 shrink-0 rounded-full border border-white/20 transition-transform hover:scale-110"
          style={{ background: expression.colour }}
          onClick={() =>
            update(expression.id, {
              colour: SERIES_COLOURS[(SERIES_COLOURS.indexOf(expression.colour) + 1) % SERIES_COLOURS.length],
            })
          }
        />
        <Select
          className="flex-1"
          value={expression.kind}
          onChange={(kind) => update(expression.id, { kind })}
          options={KIND_OPTIONS.map((k) => ({ value: k.value, label: k.label }))}
        />
        <IconButton
          title={expression.visible ? 'Hide' : 'Show'}
          onClick={() => update(expression.id, { visible: !expression.visible })}
        >
          {expression.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
        </IconButton>
        <IconButton title="More options" active={open} onClick={() => setOpen((v) => !v)}>
          <IconChevronDown size={14} className={open ? '' : '-rotate-90'} />
        </IconButton>
        <IconButton title="Delete this expression" onClick={() => remove(expression.id)}>
          <IconTrash size={13} />
        </IconButton>
      </div>

      <MathField
        value={expression.source}
        onChange={(source) => update(expression.id, { source })}
        prefix={prefix}
        placeholder={placeholderFor(expression.kind)}
        status={status}
        preview={expression.kind !== 'points' && expression.kind !== 'definition'}
      />

      {isParametric && (
        <div className="mt-1.5">
          <MathField
            value={expression.source2}
            onChange={(source2) => update(expression.id, { source2 })}
            prefix="y(t) ="
            placeholder="sin(t)"
            status={analyseExpression(expression.source2, resolvable)}
          />
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-2 border-t border-edge pt-2">
          {(isParametric || expression.kind === 'polar') && (
            <Row>
              <div className="flex-1">
                <span className="field-label">{isParametric ? 't from' : 'θ from'}</span>
                <NumberField
                  value={expression.tMin}
                  step={0.5}
                  onChange={(tMin) => update(expression.id, { tMin })}
                />
              </div>
              <div className="flex-1">
                <span className="field-label">to</span>
                <NumberField
                  value={expression.tMax}
                  step={0.5}
                  onChange={(tMax) => update(expression.id, { tMax })}
                />
              </div>
            </Row>
          )}

          <Row>
            <div className="flex-1">
              <span className="field-label">Line width</span>
              <NumberField
                value={expression.width}
                min={0.5}
                max={12}
                step={0.5}
                onChange={(width) => update(expression.id, { width })}
              />
            </div>
            <div className="flex-1">
              <span className="field-label">Style</span>
              <Select
                value={expression.style}
                onChange={(style) => update(expression.id, { style })}
                options={[
                  { value: 'solid', label: 'Solid' },
                  { value: 'dashed', label: 'Dashed' },
                  { value: 'dotted', label: 'Dotted' },
                ]}
              />
            </div>
          </Row>

          <div>
            <span className="field-label">Label</span>
            <input
              className="input-base"
              value={expression.label}
              placeholder={`Series ${index + 1}`}
              onChange={(e) => update(expression.id, { label: e.target.value })}
            />
          </div>

          {expression.kind === 'function' && (
            <>
              <Toggle
                label="Shade under the curve"
                checked={expression.fill}
                onChange={(fill) => update(expression.id, { fill })}
              />
              <Toggle
                label="Show the derivative"
                hint="Central differences, drawn dashed in the same colour."
                checked={expression.showDerivative}
                onChange={(showDerivative) => update(expression.id, { showDerivative })}
              />
              <Toggle
                label="Mark roots and turning points"
                checked={expression.showFeatures}
                onChange={(showFeatures) => update(expression.id, { showFeatures })}
              />
              <Toggle
                label="Definite integral"
                hint="Adaptive Simpson between the limits below."
                checked={expression.showIntegral}
                onChange={(showIntegral) => update(expression.id, { showIntegral })}
              />
              {expression.showIntegral && (
                <Row>
                  <div className="flex-1">
                    <span className="field-label">From</span>
                    <NumberField
                      value={expression.integralFrom}
                      step={0.5}
                      onChange={(integralFrom) => update(expression.id, { integralFrom })}
                    />
                  </div>
                  <div className="flex-1">
                    <span className="field-label">To</span>
                    <NumberField
                      value={expression.integralTo}
                      step={0.5}
                      onChange={(integralTo) => update(expression.id, { integralTo })}
                    />
                  </div>
                </Row>
              )}
            </>
          )}

          {expression.kind === 'inequality' && (
            <p className="text-2xs leading-relaxed text-ink-faint">
              Write the expression that should be positive. <span className="font-mono">y - x^2</span> shades
              everything above the parabola.
            </p>
          )}

          {expression.kind === 'points' && (
            <p className="text-2xs leading-relaxed text-ink-faint">
              One point per line as <span className="font-mono">x, y</span>, or a whole list separated by
              semicolons.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function placeholderFor(kind: ExpressionKind): string {
  switch (kind) {
    case 'parametric':
      return 'cos(3t)';
    case 'polar':
      return '1 + cos(θ)';
    case 'implicit':
      return 'x^2 + y^2 - 9';
    case 'inequality':
      return 'y - sin(x)';
    case 'points':
      return '0,0; 1,2; 2,1';
    case 'definition':
      return 'f(x) = x^2 - 3';
    default:
      return 'a*sin(b*x)';
  }
}
