import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../core/store';
import { SERIES_COLOURS, type ElementProperty, type TabState } from '../core/types';
import {
  CATEGORY_COLOURS,
  ELEMENTS,
  ELEMENT_BY_Z,
  PROPERTIES,
  PROPERTY_BY_KEY,
  orbitalSlice,
  type Element,
} from '../core/chemistry/elements';
import { SandboxLayout } from '../components/sandbox/SandboxLayout';
import { ProbePlot, type Trace } from '../components/sandbox/ProbePlot';
import {
  Callout,
  Collapsible,
  Field,
  Panel,
  SegmentedControl,
  Select,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { sequentialColour } from '../plot/scene';
import { toCsv } from '../core/serialize';

/* The periodic table.
 *
 * Two things are worth building here that a printed table cannot do. The first
 * is recolouring: the same eighteen columns shaded by atomic radius, by
 * electronegativity, by melting point, so that the periodicity stops being a
 * word and becomes a pattern that is plainly there. The second is opening an
 * element up — the shells, and then the actual orbital the outermost electrons
 * are in, which is where chemistry meets the quantum mode next door.
 *
 * The table is HTML rather than canvas. It is a grid of a hundred and eighteen
 * buttons; making it a picture would mean reimplementing hit-testing, keyboard
 * focus and tooltips to arrive back where the browser started.
 */

const CELL_MIN = 30;

function colourFor(element: Element, property: ElementProperty, range: { lo: number; hi: number } | null): string {
  if (property === 'category') return CATEGORY_COLOURS[element.category] ?? '#64748b';
  const info = PROPERTY_BY_KEY.get(property);
  if (!info || !range) return '#334155';
  const value = info.of(element);
  // Never invent a colour for a measurement nobody has made: an unmeasured
  // element reads as blank, which is the truth about it.
  if (!Number.isFinite(value)) return 'transparent';
  const t = info.logarithmic
    ? (Math.log10(Math.max(1e-6, value)) - Math.log10(Math.max(1e-6, range.lo))) /
      Math.max(1e-9, Math.log10(Math.max(1e-6, range.hi)) - Math.log10(Math.max(1e-6, range.lo)))
    : (value - range.lo) / Math.max(1e-9, range.hi - range.lo);
  return sequentialColour(Math.max(0, Math.min(1, t)));
}

function rangeOf(property: ElementProperty): { lo: number; hi: number } | null {
  const info = PROPERTY_BY_KEY.get(property);
  if (!info) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of ELEMENTS) {
    const v = info.of(e);
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

// ------------------------------------------------------------------ the atom

/**
 * The Bohr picture, animated.
 *
 * It is not what an atom is like, and the panel says so. It is, however, the
 * picture in which "two, eight, eight" is visible, and a student who cannot
 * count the electrons in the shells cannot see why the table has the shape it
 * has. The orbital view next to it is the honest one, and having both a click
 * apart is the point.
 */
function BohrAtom({ element, animate }: { element: Element; animate: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const frame = useRef(0);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let running = true;
    let raf = 0;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cx = width / 2;
      const cy = height / 2;
      const shells = element.shells;
      const outer = Math.min(width, height) / 2 - 10;
      const nucleusRadius = Math.max(7, outer * 0.13);

      // The nucleus, as a huddle of protons and neutrons rather than a dot:
      // "the nucleus is tiny and heavy" is easier to see when it is drawn as
      // the several hundred particles it actually is.
      const neutrons = Math.max(0, Math.round(element.mass) - element.z);
      const particles = Math.min(90, element.z + neutrons);
      for (let i = 0; i < particles; i++) {
        // A deterministic spiral, so the nucleus does not shimmer frame to
        // frame and is identical every time this element is opened.
        const angle = i * 2.399963;
        const r = nucleusRadius * 0.85 * Math.sqrt(i / Math.max(1, particles));
        ctx.beginPath();
        ctx.arc(cx + r * Math.cos(angle), cy + r * Math.sin(angle), Math.max(1.4, nucleusRadius * 0.16), 0, Math.PI * 2);
        ctx.fillStyle = i % 2 === 0 ? '#f87171' : '#94a3b8';
        ctx.fill();
      }

      const t = frame.current;
      shells.forEach((count, index) => {
        const radius = nucleusRadius + 14 + ((outer - nucleusRadius - 14) * (index + 1)) / shells.length;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(148,163,184,0.28)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Outer shells go round more slowly, which is both true of the Bohr
        // model and the only way a dozen concentric rings stay readable.
        const speed = 0.6 / (index + 1.4);
        for (let e = 0; e < count; e++) {
          const angle = (e / count) * Math.PI * 2 + t * speed + index;
          const x = cx + radius * Math.cos(angle);
          const y = cy + radius * Math.sin(angle);
          ctx.beginPath();
          ctx.arc(x, y, 3, 0, Math.PI * 2);
          ctx.fillStyle = index === shells.length - 1 ? '#38bdf8' : '#7dd3fc';
          ctx.fill();
        }

        ctx.fillStyle = 'rgba(148,163,184,0.75)';
        ctx.font = '9px ui-sans-serif, system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(count), cx, cy - radius - 3);
      });

      if (!running) return;
      if (animate) {
        frame.current += 0.016;
        raf = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [element, animate]);

  return <canvas ref={ref} className="h-56 w-full" aria-label={`Shell diagram for ${element.name}`} />;
}

/** |ψ|² of the hydrogen-like orbital the outermost electrons are filling. */
function OrbitalCloud({ element, probability }: { element: Element; probability: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const outermost = element.subshells[element.subshells.length - 1];

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !outermost) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = 180;
    const slice = orbitalSlice(outermost.n, outermost.l, size);
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i++) {
      const raw = slice.values[i] / slice.peak;
      const value = probability ? raw * raw : raw;
      let r = 0;
      let g = 0;
      let b = 0;
      if (probability) {
        const t = Math.sqrt(Math.max(0, value));
        r = Math.round(255 * Math.min(1, t * 1.7));
        g = Math.round(255 * Math.max(0, t * 1.5 - 0.45));
        b = Math.round(255 * Math.max(0, Math.min(1, t * 2.1 - 0.1)));
      } else if (value >= 0) {
        const t = Math.sqrt(value);
        r = Math.round(255 * t);
        g = Math.round(150 * t);
        b = Math.round(40 * t);
      } else {
        const t = Math.sqrt(-value);
        r = Math.round(40 * t);
        g = Math.round(140 * t);
        b = Math.round(255 * t);
      }
      image.data[i * 4] = r;
      image.data[i * 4 + 1] = g;
      image.data[i * 4 + 2] = b;
      image.data[i * 4 + 3] = 255;
    }
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 224;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const scratch = document.createElement('canvas');
    scratch.width = size;
    scratch.height = size;
    scratch.getContext('2d')?.putImageData(image, 0, 0);
    const side = Math.min(canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(scratch, (canvas.width - side) / 2, (canvas.height - side) / 2, side, side);
  }, [outermost, probability]);

  if (!outermost) return null;
  return <canvas ref={ref} className="h-56 w-full" aria-label={`Orbital shape for ${element.name}`} />;
}

// ------------------------------------------------------------------ panel

const PROPERTY_OPTIONS = [
  { value: 'category' as const, label: 'Category' },
  ...PROPERTIES.map((p) => ({ value: p.key as ElementProperty, label: p.label })),
];

export function ChemistryPanel({ tab }: { tab: TabState }) {
  const cfg = tab.chemistry;
  const setChemistry = useStore((s) => s.setChemistry);
  const element = ELEMENT_BY_Z.get(cfg.selected) ?? ELEMENTS[0];
  const info = PROPERTY_BY_KEY.get(cfg.colourBy);

  return (
    <>
      <Panel title="Colour the table by">
        <Select
          value={cfg.colourBy}
          onChange={(colourBy) => setChemistry({ colourBy })}
          options={PROPERTY_OPTIONS}
        />
        {info && <p className="px-0.5 text-2xs text-ink-faint">{info.hint}</p>}
        {cfg.colourBy === 'category' && (
          <div className="grid grid-cols-2 gap-1 pt-1">
            {Object.entries(CATEGORY_COLOURS).map(([name, colour]) => (
              <div key={name} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
                <span className="text-2xs text-ink-dim">{name}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Trend plot">
        <Toggle
          label="Plot a property against atomic number"
          hint="The periodicity, as a graph: every peak is a group."
          checked={cfg.showTrend}
          onChange={(showTrend) => setChemistry({ showTrend })}
        />
        {cfg.showTrend && (
          <Field label="Property">
            <Select
              value={cfg.plotProperty}
              onChange={(plotProperty) => setChemistry({ plotProperty })}
              options={PROPERTIES.map((p) => ({ value: p.key as ElementProperty, label: p.label }))}
            />
          </Field>
        )}
      </Panel>

      <Panel title={`${element.name} — the atom`}>
        <SegmentedControl
          size="sm"
          value={cfg.atomView}
          onChange={(atomView) => setChemistry({ atomView })}
          options={[
            { value: 'shells', label: 'Shells', title: 'The Bohr picture: electrons in numbered shells.' },
            { value: 'orbital', label: 'Orbital', title: 'The real shape of the outermost subshell.' },
          ]}
        />
        {cfg.atomView === 'shells' ? (
          <Toggle
            label="Set the electrons going"
            checked={cfg.animate}
            onChange={(animate) => setChemistry({ animate })}
          />
        ) : (
          <Callout kind="info">
            A hydrogen-like orbital at the same n and l as {element.symbol}'s outermost subshell.
            Real multi-electron orbitals have no closed form; the shape, the nodes and where the
            density lies are right, the size is not.
          </Callout>
        )}
      </Panel>
    </>
  );
}

// ------------------------------------------------------------------ surface

export function ChemistrySurface({ tab }: { tab: TabState }) {
  const cfg = tab.chemistry;
  const setChemistry = useStore((s) => s.setChemistry);
  const element = ELEMENT_BY_Z.get(cfg.selected) ?? ELEMENTS[0];
  const range = useMemo(() => rangeOf(cfg.colourBy), [cfg.colourBy]);

  const select = useCallback((z: number) => setChemistry({ selected: z }), [setChemistry]);

  const trend = useMemo((): Trace[] => {
    if (!cfg.showTrend) return [];
    const info = PROPERTY_BY_KEY.get(cfg.plotProperty);
    if (!info) return [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const e of ELEMENTS) {
      const v = info.of(e);
      if (!Number.isFinite(v)) continue;
      xs.push(e.z);
      ys.push(v);
    }
    return [
      {
        id: cfg.plotProperty,
        label: info.label,
        unit: info.unit,
        colour: SERIES_COLOURS[0],
        xs: Float64Array.from(xs),
        ys: Float64Array.from(ys),
      },
    ];
  }, [cfg.showTrend, cfg.plotProperty]);

  return (
    <SandboxLayout
      storageKey="chemistry"
      canvas={
        <div className="flex h-full w-full flex-col overflow-auto p-3">
          <Table selected={cfg.selected} colourBy={cfg.colourBy} range={range} onSelect={select} />
          {cfg.colourBy !== 'category' && range && (
            <Legend property={cfg.colourBy} range={range} />
          )}
        </div>
      }
      instruments={
        <>
          <div className="border-b border-edge px-3 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <div>
                <div className="text-2xl font-semibold text-ink">{element.symbol}</div>
                <div className="text-xs text-ink-dim">{element.name}</div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm text-ink">{element.z}</div>
                <div className="text-2xs text-ink-faint">{element.category}</div>
              </div>
            </div>
          </div>

          {cfg.atomView === 'shells' ? (
            <BohrAtom element={element} animate={cfg.animate} />
          ) : (
            <OrbitalCloud element={element} probability />
          )}

          <div className="px-3 pb-2 text-center text-2xs text-ink-faint">
            {cfg.atomView === 'shells'
              ? `${element.z} protons, ${Math.max(0, Math.round(element.mass) - element.z)} neutrons, shells ${element.shells.join(', ')}`
              : `${element.subshells[element.subshells.length - 1]?.label ?? ''} — the outermost subshell, m = 0`}
          </div>

          <Collapsible title="Electron configuration" defaultOpen>
            <div className="space-y-1.5">
              <div className="rounded-md border border-edge bg-surface-1 px-2 py-1.5 font-mono text-2xs text-ink">
                {element.shortConfiguration}
              </div>
              <div className="break-words px-0.5 font-mono text-2xs text-ink-faint">{element.configuration}</div>
              <div className="flex flex-wrap gap-1 pt-0.5">
                {element.subshells.map((s) => (
                  <span
                    key={s.label}
                    className="rounded border border-edge px-1.5 py-0.5 font-mono text-2xs text-ink-dim"
                    title={`n = ${s.n}, l = ${s.l}`}
                  >
                    {s.label}
                    <span className="text-ink">{s.electrons}</span>
                  </span>
                ))}
              </div>
            </div>
          </Collapsible>

          <div className="border-t border-edge px-3 py-2.5">
            <StatList>
              <Stat label="Relative atomic mass" value={fmt(element.mass, 6)} />
              <Stat label="Group, period" value={`${element.group || '—'}, ${element.period}`} />
              <Stat label="Block" value={`${element.block}-block`} />
              <Stat label="Oxidation states" value={element.oxidation || '—'} />
              {PROPERTIES.filter((p) => p.key !== 'mass' && p.key !== 'discovered').map((p) => {
                const value = p.of(element);
                return (
                  <Stat
                    key={p.key}
                    label={p.label}
                    value={Number.isFinite(value) ? `${fmt(value, 5)}${p.unit ? ` ${p.unit}` : ''}` : 'not measured'}
                  />
                );
              })}
              <Stat label="Discovered" value={element.discovered || '—'} />
            </StatList>
          </div>

          {cfg.showTrend && trend.length > 0 && (
            <>
              <ProbePlot traces={trend} xLabel="atomic number" cursorTime={element.z} height={200} />
              <p className="px-3 pb-3 text-2xs text-ink-faint">
                {PROPERTY_BY_KEY.get(cfg.plotProperty)?.hint}
              </p>
            </>
          )}
        </>
      }
    />
  );
}

function Table({
  selected,
  colourBy,
  range,
  onSelect,
}: {
  selected: number;
  colourBy: ElementProperty;
  range: { lo: number; hi: number } | null;
  onSelect: (z: number) => void;
}) {
  return (
    <div
      className="grid gap-[2px]"
      style={{
        gridTemplateColumns: `repeat(18, minmax(${CELL_MIN}px, 1fr))`,
        gridTemplateRows: 'repeat(7, auto) 10px repeat(2, auto)',
      }}
      role="grid"
      aria-label="Periodic table"
    >
      {/* The two cells the f-block was lifted out of. Without them the table
        * has a hole between barium and hafnium with nothing to say why, and
        * the pulled-out rows below look like a separate table. */}
      {[
        { row: 6, label: '57–71' },
        { row: 7, label: '89–103' },
      ].map((placeholder) => (
        <div
          key={placeholder.row}
          style={{ gridColumn: 3, gridRow: placeholder.row }}
          className="flex aspect-square min-w-0 items-center justify-center rounded-sm border border-dashed border-edge text-[8px] text-ink-faint"
        >
          {placeholder.label}
        </div>
      ))}
      {ELEMENTS.map((e) => {
        const background = colourFor(e, colourBy, range);
        const chosen = e.z === selected;
        return (
          <button
            key={e.z}
            type="button"
            data-element={e.symbol}
            onClick={() => onSelect(e.z)}
            title={`${e.name} — ${e.category}`}
            style={{
              gridColumn: e.column,
              gridRow: e.row,
              background: background === 'transparent' ? undefined : background,
            }}
            className={`flex aspect-square min-w-0 flex-col items-center justify-center rounded-sm border text-center transition-transform ${
              chosen ? 'border-white ring-1 ring-white' : 'border-black/25 hover:scale-110'
            } ${background === 'transparent' ? 'border-dashed border-edge' : ''}`}
          >
            <span className="text-[8px] leading-none text-black/55">{e.z}</span>
            <span className="text-[11px] font-semibold leading-tight text-black/85">{e.symbol}</span>
          </button>
        );
      })}
    </div>
  );
}

function Legend({ property, range }: { property: ElementProperty; range: { lo: number; hi: number } }) {
  const info = PROPERTY_BY_KEY.get(property);
  if (!info) return null;
  const stops = Array.from({ length: 24 }, (_, i) => sequentialColour(i / 23));
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="font-mono text-2xs text-ink-faint">
        {fmt(range.lo, 4)}
        {info.unit ? ` ${info.unit}` : ''}
      </span>
      <div className="flex h-2.5 flex-1 overflow-hidden rounded">
        {stops.map((colour, i) => (
          <span key={i} className="flex-1" style={{ background: colour }} />
        ))}
      </div>
      <span className="font-mono text-2xs text-ink-faint">
        {fmt(range.hi, 4)}
        {info.unit ? ` ${info.unit}` : ''}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ export

export function chemistryCsv(): string {
  const headers = [
    'atomic_number',
    'symbol',
    'name',
    'group',
    'period',
    'block',
    'configuration',
    ...PROPERTIES.map((p) => (p.unit ? `${p.key}_${p.unit.replace(/[^\w]/g, '')}` : p.key)),
  ];
  return toCsv(
    headers,
    ELEMENTS.map((e) => [
      e.z,
      e.symbol,
      e.name,
      e.group || '',
      e.period,
      e.block,
      e.configuration,
      ...PROPERTIES.map((p) => {
        const v = p.of(e);
        return Number.isFinite(v) ? v : '';
      }),
    ]),
  );
}
