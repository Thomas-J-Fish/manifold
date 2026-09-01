import katex from 'katex';
import { useMemo } from 'react';
import { ExpressionError, freeSymbols, parseExpression, toLatex } from '../../core/math/compile';
import { FUNCTIONS } from '../../core/math/functions';

export interface MathFieldStatus {
  ok: boolean;
  latex: string | null;
  error: string | null;
  detail: string | null;
  symbols: string[];
}

/** Parses once and reports everything the UI needs to know about a source
 *  string: whether it is valid, how it renders, and what it depends on. */
export function analyseExpression(source: string, known: Set<string>): MathFieldStatus {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, latex: null, error: null, detail: null, symbols: [] };
  try {
    const node = parseExpression(trimmed);
    const symbols = freeSymbols(node).filter((s) => !(s in FUNCTIONS));
    const unknown = symbols.filter((s) => !known.has(s));
    return {
      ok: true,
      latex: toLatex(trimmed),
      error: null,
      detail: unknown.length
        ? `Unbound: ${unknown.join(', ')}`
        : null,
      symbols,
    };
  } catch (err) {
    const message = err instanceof ExpressionError ? err.message : 'Could not read this expression';
    const detail = err instanceof ExpressionError ? (err.detail ?? null) : String(err);
    return { ok: false, latex: null, error: message, detail, symbols: [] };
  }
}

function renderLatex(latex: string | null): string | null {
  if (!latex) return null;
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode: false,
      output: 'html',
      strict: false,
    });
  } catch {
    return null;
  }
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Rendered to the left of the box, e.g. "y =" or "r(θ) =". */
  prefix?: string;
  placeholder?: string;
  status?: MathFieldStatus;
  /** Show the typeset preview under the input. */
  preview?: boolean;
  onEnter?: () => void;
  autoFocus?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * A single-line expression input with a live typeset preview.
 *
 * The input stays plain text rather than becoming a rich math editor. That is a
 * deliberate trade: a WYSIWYG field looks better in a screenshot but is slower
 * to type into, impossible to paste into, and cannot round-trip through a
 * project file as the exact characters the user wrote. Typing `a*sin(b*x)` and
 * seeing it set in real type below gets the legibility without the cost.
 */
export function MathField({
  value,
  onChange,
  prefix,
  placeholder,
  status,
  preview = true,
  onEnter,
  autoFocus,
  disabled,
  className = '',
}: Props) {
  const html = useMemo(() => renderLatex(status?.latex ?? null), [status?.latex]);
  const hasError = Boolean(status && !status.ok && status.error);

  return (
    <div className={className}>
      <div
        className={`flex items-stretch overflow-hidden rounded-md border bg-surface-1 transition-colors
          ${hasError ? 'border-rose-500/60' : 'border-edge focus-within:border-accent hover:border-edge-strong'}`}
      >
        {prefix && (
          <span className="flex select-none items-center border-r border-edge bg-surface-2 px-2 font-mono text-xs text-ink-faint">
            {prefix}
          </span>
        )}
        <input
          type="text"
          className="min-w-0 flex-1 bg-transparent px-2 py-1.5 font-mono text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onEnter?.();
          }}
        />
      </div>

      {preview && html && (
        <div
          className="mt-1 overflow-x-auto px-1 py-0.5 text-[15px] leading-relaxed text-ink-dim"
          // KaTeX output is generated here from a parsed AST, never from user
          // HTML: the string is built by KaTeX's own serialiser out of the
          // token stream mathjs produced, so there is no path from typed text
          // to markup.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {hasError && (
        <p className="mt-1 text-2xs leading-snug text-rose-300">
          {status!.error}
          {status!.detail && <span className="block text-rose-400/70">{status!.detail}</span>}
        </p>
      )}
      {!hasError && status?.detail && (
        <p className="mt-1 text-2xs text-amber-300/80">{status.detail}</p>
      )}
    </div>
  );
}

/** Typesets a LaTeX string for display outside an input. */
export function Formula({
  latex,
  display = false,
  className = '',
}: {
  latex: string;
  display?: boolean;
  className?: string;
}) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(latex, {
        throwOnError: false,
        displayMode: display,
        output: 'html',
        strict: false,
      });
    } catch {
      return null;
    }
  }, [latex, display]);
  if (!html) return <span className={`font-mono text-xs ${className}`}>{latex}</span>;
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
