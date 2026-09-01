/* The control vocabulary the mode panels are built from.
 *
 * These exist so every panel in the app has the same density, the same label
 * placement and the same keyboard behaviour. In particular `NumberField`
 * carries the rule that a numeric input should keep whatever the user is typing
 * — including a half-finished "-" or "1e" — and only commit a value when it
 * parses, which is the difference between a field you can type in and one that
 * fights you.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { IconChevronDown } from './Icons';

// ------------------------------------------------------------------ layout

export function Panel({
  title,
  children,
  actions,
  className = '',
  dense = false,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <header className="panel-heading">
          <span>{title}</span>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={dense ? 'p-2' : 'space-y-3 p-3'}>{children}</div>
    </section>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = true,
  actions,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="panel">
      <header className="panel-heading">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 text-left uppercase tracking-wider text-ink-faint hover:text-ink-dim"
          onClick={() => setOpen((v) => !v)}
        >
          <IconChevronDown
            size={13}
            className={`transition-transform duration-150 ${open ? '' : '-rotate-90'}`}
          />
          {title}
        </button>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </header>
      {open && <div className="space-y-3 p-3">{children}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  inline = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  inline?: boolean;
}) {
  if (inline) {
    return (
      <label className="flex items-center justify-between gap-3">
        <span className="field-label flex-1 normal-case">{label}</span>
        <div className="w-32 shrink-0">{children}</div>
      </label>
    );
  }
  return (
    <label className="block space-y-1">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="block text-2xs leading-snug text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Row({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`flex items-center gap-2 ${className}`}>{children}</div>;
}

// ------------------------------------------------------------------ inputs

interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Decimal places used when the value is written back into the box. */
  precision?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  precision = 6,
  suffix,
  disabled,
  className = '',
  placeholder,
}: NumberFieldProps) {
  const [text, setText] = useState(() => formatNumber(value, precision));
  const focused = useRef(false);

  // While the field has focus the text belongs to the user; outside changes
  // (a slider moving, a project loading) are only allowed to overwrite it when
  // it does not.
  useEffect(() => {
    if (!focused.current) setText(formatNumber(value, precision));
  }, [value, precision]);

  const commit = (raw: string) => {
    const parsed = Number(raw.replace(/[−–—]/g, '-').trim());
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      setText(formatNumber(value, precision));
      return;
    }
    let next = parsed;
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    onChange(next);
    setText(formatNumber(next, precision));
  };

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        inputMode="decimal"
        className={`input-base font-mono ${suffix ? 'pr-8' : ''}`}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => {
          focused.current = true;
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          focused.current = false;
          commit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(formatNumber(value, precision));
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            // Arrow keys nudge by the step, ×10 with shift and ÷10 with alt —
            // the convention every design tool uses.
            e.preventDefault();
            const base = step ?? 1;
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * base * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
            commit(String(value + delta));
          }
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-2xs text-ink-faint">
          {suffix}
        </span>
      )}
    </div>
  );
}

export function formatNumber(v: number, precision = 6): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : 'NaN';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e7 || abs < 1e-5) return v.toExponential(Math.min(precision, 6));
  const fixed = v.toFixed(precision);
  return precision > 0 ? fixed.replace(/\.?0+$/, '') : fixed;
}

export function TextField({
  value,
  onChange,
  placeholder,
  mono = false,
  disabled,
  className = '',
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
  onEnter?: () => void;
}) {
  return (
    <input
      type="text"
      className={`input-base ${mono ? 'font-mono' : ''} ${className}`}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEnter?.();
      }}
    />
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; group?: string }[];
  disabled?: boolean;
  className?: string;
}) {
  const groups = new Map<string, typeof options>();
  for (const o of options) {
    const key = o.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(o);
  }
  return (
    <div className={`relative ${className}`}>
      <select
        className="input-base cursor-pointer appearance-none pr-7"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {[...groups.entries()].map(([group, items]) =>
          group ? (
            <optgroup key={group} label={group}>
              {items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : (
            items.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ),
        )}
      </select>
      <IconChevronDown
        size={13}
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint"
      />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3">
      <label htmlFor={id} className="flex-1 cursor-pointer">
        <span className="block text-xs text-ink-dim">{label}</span>
        {hint && <span className="block text-2xs leading-snug text-ink-faint">{hint}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors duration-150
          ${checked ? 'border-accent-deep bg-accent' : 'border-edge bg-surface-1'}
          ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
      >
        {/* `left-0` is load-bearing. Without a horizontal offset an absolutely
            positioned box falls back to its *static* position, and a <button>
            centres its content — so the thumb started near the middle of the
            track and the "on" translation carried it off the right-hand end. */}
        <span
          className={`absolute left-0 top-[2px] h-[12px] w-[12px] rounded-full bg-white shadow transition-transform duration-150 ease-snap
            ${checked ? 'translate-x-[16px]' : 'translate-x-[2px]'}`}
        />
      </button>
    </div>
  );
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={`inline-flex w-full rounded-md border border-edge bg-surface-1 p-0.5 ${
        size === 'sm' ? 'text-2xs' : 'text-xs'
      }`}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          title={o.title}
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 truncate rounded px-2 py-1 font-medium transition-colors duration-100
            ${value === o.value ? 'bg-accent text-white shadow' : 'text-ink-dim hover:bg-surface-3 hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  disabled?: boolean;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="manifold-slider"
      style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, fill))}%` }}
      value={Number.isFinite(value) ? value : min}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
    />
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  title,
  className = '',
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'accent' | 'ghost';
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
  /** A stable hook for the end-to-end tests, which must not depend on labels. */
  testId?: string;
}) {
  const variantClass = variant === 'accent' ? 'btn-accent' : variant === 'ghost' ? 'btn-ghost' : '';
  return (
    <button
      type={type}
      className={`btn ${variantClass} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export function IconButton({
  children,
  onClick,
  title,
  active = false,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-100
        ${active ? 'border-accent-deep bg-accent/20 text-accent-soft' : 'border-transparent text-ink-faint hover:bg-surface-3 hover:text-ink'}
        ${disabled ? 'cursor-not-allowed opacity-35' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

/** A key/value line for the read-only statistics panels. */
export function Stat({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <>
      <dt className="truncate text-ink-faint" title={hint ?? label}>
        {label}
      </dt>
      <dd className={`text-right tabular-nums ${emphasis ? 'font-semibold text-accent-soft' : 'text-ink'}`}>
        {value}
      </dd>
    </>
  );
}

export function StatList({ children }: { children: ReactNode }) {
  return <dl className="stat-grid">{children}</dl>;
}

export function Callout({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn' | 'error';
  children: ReactNode;
}) {
  const palette =
    kind === 'error'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
      : kind === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : 'border-edge bg-surface-1 text-ink-dim';
  return <div className={`rounded-md border px-2.5 py-2 text-2xs leading-relaxed ${palette}`}>{children}</div>;
}

/** Formats a number for display in a results panel. */
export function fmt(v: number, digits = 5): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e6 || abs < 1e-4) return v.toExponential(Math.min(digits, 4));
  return Number(v.toPrecision(digits)).toString();
}

/** Formats a p-value, which needs its own rule at the small end. */
export function fmtP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-15) return '< 1e−15';
  if (p < 1e-4) return p.toExponential(2).replace('e-', 'e−');
  return p.toFixed(4);
}
