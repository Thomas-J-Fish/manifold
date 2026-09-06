import { useMemo } from 'react';
import * as THREE from 'three';
import { useStore } from '../core/store';
import type { LinAlgConfig, TabState } from '../core/types';
import { SERIES_COLOURS } from '../core/types';
import {
  apply,
  conditionNumber,
  determinant,
  eigen,
  formatMatrix,
  identity,
  interpolateFromIdentity,
  intersectPlanes,
  intersectThreePlanes,
  inverse,
  multiply,
  rank,
  rotation2,
  rref,
  scaling2,
  shear2,
  singularValues,
  trace,
  transpose,
  type Matrix,
} from '../core/math/linalg';
import { uid } from '../core/defaults';
import { Plot2D } from '../components/plot/Plot2D';
import { Scene3D, addAxes, makeLabel, makeVector } from '../components/plot/Scene3D';
import { usePlot2DRef, usePlotRef } from '../components/shell/PlotContext';
import { MatrixDisplay, MatrixEditor } from '../components/panels/MatrixEditor';
import { ViewPanel } from '../components/panels/ViewPanel';
import {
  Button,
  Callout,
  Collapsible,
  Field,
  IconButton,
  NumberField,
  Row,
  SegmentedControl,
  Slider,
  Stat,
  StatList,
  Toggle,
  fmt,
} from '../components/ui/controls';
import { IconEye, IconEyeOff, IconPlus, IconTrash } from '../components/ui/Icons';
import type { Layer, PlotScene } from '../plot/scene';

/** The interpolation parameter, driven by the clock while it is running. */
function effectiveProgress(tab: TabState): number {
  if (!tab.timeline.playing) return tab.linalg.progress;
  const period = 4;
  const phase = (tab.timeline.t / period) % 2;
  return phase < 1 ? phase : 2 - phase;
}

/* ------------------------------------------------------------------ panel */

export function LinearAlgebraPanel({ tab }: { tab: TabState }) {
  const setLinAlg = useStore((s) => s.setLinAlg);
  const cfg = tab.linalg;

  return (
    <>
      <Collapsible title="Mode">
        <SegmentedControl
          value={cfg.view}
          onChange={(view) => setLinAlg({ view })}
          options={[
            { value: 'transform2d', label: '2D', title: 'Plane transformations' },
            { value: 'transform3d', label: '3D', title: 'Space transformations' },
            { value: 'planes', label: 'Planes', title: 'Planes and their intersections' },
            { value: 'calculator', label: 'Calc', title: 'Matrix calculator' },
          ]}
        />
      </Collapsible>

      {cfg.view === 'transform2d' && <Transform2DPanel tab={tab} cfg={cfg} />}
      {cfg.view === 'transform3d' && <Transform3DPanel cfg={cfg} />}
      {cfg.view === 'planes' && <PlanesPanel cfg={cfg} />}
      {cfg.view === 'calculator' && <CalculatorPanel cfg={cfg} />}

      {cfg.view === 'transform2d' && <ViewPanel tab={tab} />}
      {(cfg.view === 'transform3d' || cfg.view === 'planes') && <CameraPanel tab={tab} />}
    </>
  );
}

/**
 * The camera, as numbers as well as as a drag.
 *
 * The scene has always been orbitable, and that was the whole problem: a
 * picture that responds to being dragged looks identical to one that does not
 * until you happen to try. Writing the angles down makes the gesture
 * discoverable, and it makes the view *repeatable* — "looking down the x
 * axis", "straight down from above" — which no amount of dragging does.
 */
function CameraPanel({ tab }: { tab: TabState }) {
  const patchActive = useStore((s) => s.patchActive);
  const c = tab.camera;
  const set = (patch: Partial<TabState['camera']>) => patchActive({ camera: { ...c, ...patch } });
  const degrees = (rad: number) => (rad * 180) / Math.PI;
  const radians = (deg: number) => (deg * Math.PI) / 180;

  return (
    <Collapsible title="Camera">
      <Field label="Turn (°)" hint="Or drag the scene itself.">
        <Slider
          value={Math.round(degrees(c.theta))}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => set({ theta: radians(v) })}
        />
      </Field>
      <Field label="Height (°)">
        {/* Clamped short of the poles, where the up vector degenerates and the
            view flips over — the same limit the drag handler enforces. */}
        <Slider
          value={Math.round(degrees(c.phi))}
          min={3}
          max={177}
          step={1}
          onChange={(v) => set({ phi: radians(v) })}
        />
      </Field>
      <Field label="Distance">
        <Slider value={c.distance} min={3} max={60} step={0.5} onChange={(distance) => set({ distance })} />
      </Field>
      <Row>
        <Button
          onClick={() => set({ theta: 0.9, phi: 1.05, distance: 15, target: [0, 0, 0] })}
          title="Back to the angle the tab opened at"
        >
          Reset view
        </Button>
        <Button onClick={() => set({ theta: 0, phi: 0.05, target: [0, 0, 0] })} title="Straight down onto the xy plane">
          Top down
        </Button>
        <Button onClick={() => set({ theta: 0, phi: Math.PI / 2, target: [0, 0, 0] })} title="Along the y axis">
          Front on
        </Button>
      </Row>
    </Collapsible>
  );
}

function Transform2DPanel({ tab, cfg }: { tab: TabState; cfg: LinAlgConfig }) {
  const setLinAlg = useStore((s) => s.setLinAlg);
  const m = cfg.matrix2;
  const progress = effectiveProgress(tab);
  const current = interpolateFromIdentity(m, progress);
  const det = determinant(m);
  const e = useMemo(() => eigen(m), [m]);
  const sv = useMemo(() => singularValues(m), [m]);

  return (
    <>
      <Collapsible title="Matrix">
        <MatrixEditor matrix={m} onChange={(matrix2) => setLinAlg({ matrix2 })} />

        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="field-label">Interpolate from the identity</span>
            <span className="font-mono text-2xs text-ink">{progress.toFixed(2)}</span>
          </div>
          <Slider
            value={progress}
            min={0}
            max={1}
            step={0.001}
            disabled={tab.timeline.playing}
            onChange={(v) => setLinAlg({ progress: v })}
          />
          <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
            Press play below and the clock takes this over, sweeping there and back.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-1">
          {[
            { label: 'Rotate 30°', m: rotation2(Math.PI / 6) },
            { label: 'Rotate 90°', m: rotation2(Math.PI / 2) },
            { label: 'Scale 2×', m: scaling2(2, 2) },
            { label: 'Squash', m: scaling2(2, 0.5) },
            { label: 'Shear', m: shear2(1, 0) },
            { label: 'Reflect', m: [[1, 0], [0, -1]] as Matrix },
            { label: 'Singular', m: [[1, 2], [2, 4]] as Matrix },
            { label: 'Rotate+scale', m: multiply(rotation2(Math.PI / 5), scaling2(1.4, 1.4)) },
            { label: 'Identity', m: identity(2) },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setLinAlg({ matrix2: preset.m })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="What it does">
        <StatList>
          <Stat label="Determinant" value={fmt(det)} emphasis />
          <Stat label="Trace" value={fmt(trace(m))} />
          <Stat label="Rank" value={String(rank(m))} />
          <Stat label="Condition number" value={fmt(conditionNumber(m))} />
          <Stat label="Singular values" value={sv.map((s) => fmt(s, 4)).join(', ')} />
        </StatList>

        <Callout kind={Math.abs(det) < 1e-9 ? 'warn' : 'info'}>
          {Math.abs(det) < 1e-9
            ? 'The determinant is zero: this matrix collapses the plane onto a line (or a point). It has no inverse, and area is destroyed.'
            : det < 0
              ? `Areas are scaled by ${fmt(Math.abs(det))} and orientation is reversed — the plane is flipped over.`
              : `Every area is multiplied by ${fmt(det)}, and orientation is preserved.`}
        </Callout>

        <div>
          <p className="field-label mb-1">Eigenvalues</p>
          {e.values.map((v, i) => (
            <p key={i} className="font-mono text-xs text-ink">
              λ{i + 1} = {Math.abs(v.im) < 1e-12 ? fmt(v.re) : `${fmt(v.re)} ${v.im >= 0 ? '+' : '−'} ${fmt(Math.abs(v.im))}i`}
              {e.vectors[i] && (
                <span className="text-ink-faint">
                  {'  '}v = ({fmt(e.vectors[i]![0], 4)}, {fmt(e.vectors[i]![1], 4)})
                </span>
              )}
            </p>
          ))}
          {e.values.every((v) => Math.abs(v.im) > 1e-12) && (
            <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
              Both eigenvalues are complex, so no real direction survives untilted — the transformation
              rotates every vector.
            </p>
          )}
        </div>

        <div>
          <p className="field-label mb-1">Currently applied</p>
          <MatrixDisplay matrix={current} />
        </div>
      </Collapsible>

      <Collapsible title="Vectors" defaultOpen={false}>
        {cfg.vectors.map((v) => (
          <div key={v.id} className="flex items-end gap-1.5">
            <span className="mb-2 h-3 w-3 shrink-0 rounded-full" style={{ background: v.colour }} />
            <div className="flex-1">
              <span className="field-label">x</span>
              <NumberField
                value={v.v[0]}
                step={0.25}
                onChange={(x) =>
                  setLinAlg({
                    vectors: cfg.vectors.map((w) => (w.id === v.id ? { ...w, v: [x, w.v[1]] } : w)),
                  })
                }
              />
            </div>
            <div className="flex-1">
              <span className="field-label">y</span>
              <NumberField
                value={v.v[1]}
                step={0.25}
                onChange={(y) =>
                  setLinAlg({
                    vectors: cfg.vectors.map((w) => (w.id === v.id ? { ...w, v: [w.v[0], y] } : w)),
                  })
                }
              />
            </div>
            <IconButton
              title="Remove this vector"
              className="mb-1"
              onClick={() => setLinAlg({ vectors: cfg.vectors.filter((w) => w.id !== v.id) })}
            >
              <IconTrash size={13} />
            </IconButton>
          </div>
        ))}
        <Button
          onClick={() =>
            setLinAlg({
              vectors: [
                ...cfg.vectors,
                {
                  id: uid('vec'),
                  v: [1, 1],
                  colour: SERIES_COLOURS[(cfg.vectors.length + 3) % SERIES_COLOURS.length],
                  label: `v${cfg.vectors.length + 1}`,
                },
              ],
            })
          }
        >
          <IconPlus size={13} /> Add a vector
        </Button>

        <Toggle
          label="Show eigenvector directions"
          checked={cfg.showEigenvectors}
          onChange={(showEigenvectors) => setLinAlg({ showEigenvectors })}
        />
        <Toggle
          label="Show the unit square"
          hint="Its area is the determinant."
          checked={cfg.showUnitSquare}
          onChange={(showUnitSquare) => setLinAlg({ showUnitSquare })}
        />
        <Toggle
          label="Show the transformed grid"
          checked={cfg.showGrid}
          onChange={(showGrid) => setLinAlg({ showGrid })}
        />
      </Collapsible>
    </>
  );
}

function Transform3DPanel({ cfg }: { cfg: LinAlgConfig }) {
  const setLinAlg = useStore((s) => s.setLinAlg);
  const m = cfg.matrix3;
  const det = determinant(m);
  const e = useMemo(() => eigen(m), [m]);

  return (
    <>
      <Collapsible title="Matrix">
        <MatrixEditor matrix={m} onChange={(matrix3) => setLinAlg({ matrix3 })} />
        <div>
          <div className="mb-1 flex items-baseline justify-between">
            <span className="field-label">Interpolate from the identity</span>
            <span className="font-mono text-2xs text-ink">{cfg.progress.toFixed(2)}</span>
          </div>
          <Slider value={cfg.progress} min={0} max={1} step={0.001} onChange={(progress) => setLinAlg({ progress })} />
        </div>
        <div className="grid grid-cols-2 gap-1">
          {[
            { label: 'Rotate about z', m: [[0.7071, -0.7071, 0], [0.7071, 0.7071, 0], [0, 0, 1]] },
            { label: 'Stretch z', m: [[1, 0, 0], [0, 1, 0], [0, 0, 2.2]] },
            { label: 'Shear xz', m: [[1, 0, 0.8], [0, 1, 0], [0, 0, 1]] },
            { label: 'Project to xy', m: [[1, 0, 0], [0, 1, 0], [0, 0, 0]] },
            { label: 'Reflect in xy', m: [[1, 0, 0], [0, 1, 0], [0, 0, -1]] },
            { label: 'Identity', m: identity(3) },
          ].map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setLinAlg({ matrix3: p.m as Matrix })}
              className="rounded border border-edge px-1 py-1 text-2xs text-ink-dim transition-colors hover:border-accent-deep hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Properties">
        <StatList>
          <Stat label="Determinant" value={fmt(det)} emphasis />
          <Stat label="Trace" value={fmt(trace(m))} />
          <Stat label="Rank" value={String(rank(m))} />
          <Stat label="Condition number" value={fmt(conditionNumber(m))} />
        </StatList>
        <Callout kind={Math.abs(det) < 1e-9 ? 'warn' : 'info'}>
          {Math.abs(det) < 1e-9
            ? 'Zero determinant: space is flattened into a plane, a line or a point. Volume is destroyed and the map cannot be undone.'
            : `Volumes are multiplied by ${fmt(Math.abs(det))}${det < 0 ? ', with orientation reversed' : ''}.`}
        </Callout>
        <div>
          <p className="field-label mb-1">Eigenvalues</p>
          {e.values.map((v, i) => (
            <p key={i} className="font-mono text-xs text-ink">
              λ{i + 1} = {Math.abs(v.im) < 1e-12 ? fmt(v.re) : `${fmt(v.re)} ${v.im >= 0 ? '+' : '−'} ${fmt(Math.abs(v.im))}i`}
            </p>
          ))}
        </div>
        <Toggle label="Show the grid" checked={cfg.showGrid} onChange={(showGrid) => setLinAlg({ showGrid })} />
      </Collapsible>
    </>
  );
}

function PlanesPanel({ cfg }: { cfg: LinAlgConfig }) {
  const setLinAlg = useStore((s) => s.setLinAlg);
  const visible = cfg.planes.filter((p) => p.visible);

  const analysis = useMemo(() => {
    if (visible.length === 3) return intersectThreePlanes(visible[0], visible[1], visible[2]);
    if (visible.length === 2) return intersectPlanes(visible[0], visible[1]);
    return null;
  }, [visible]);

  return (
    <>
      <Collapsible title="Planes">
        <p className="text-2xs leading-relaxed text-ink-faint">
          Each row is a plane <span className="font-mono text-ink-dim">ax + by + cz = d</span>. Together they
          are a linear system; the picture is its solution set.
        </p>
        {cfg.planes.map((p, i) => (
          <div key={p.id} className="rounded-md border border-edge bg-surface-1 p-2">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-3 w-3 rounded-full" style={{ background: p.colour }} />
              <span className="flex-1 text-2xs text-ink-dim">Plane {i + 1}</span>
              <IconButton
                title={p.visible ? 'Hide this plane' : 'Show this plane'}
                onClick={() =>
                  setLinAlg({ planes: cfg.planes.map((q) => (q.id === p.id ? { ...q, visible: !q.visible } : q)) })
                }
              >
                {p.visible ? <IconEye size={14} /> : <IconEyeOff size={14} />}
              </IconButton>
              <IconButton
                title="Remove this plane"
                onClick={() => setLinAlg({ planes: cfg.planes.filter((q) => q.id !== p.id) })}
              >
                <IconTrash size={13} />
              </IconButton>
            </div>
            <div className="flex gap-1">
              {(['a', 'b', 'c', 'd'] as const).map((key) => (
                <div key={key} className="flex-1">
                  <span className="field-label">{key}</span>
                  <NumberField
                    value={p[key]}
                    step={0.5}
                    onChange={(v) =>
                      setLinAlg({ planes: cfg.planes.map((q) => (q.id === p.id ? { ...q, [key]: v } : q)) })
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        {cfg.planes.length < 4 && (
          <Button
            onClick={() =>
              setLinAlg({
                planes: [
                  ...cfg.planes,
                  {
                    id: uid('pl'),
                    a: 1,
                    b: 0,
                    c: 0,
                    d: 1,
                    colour: SERIES_COLOURS[cfg.planes.length % SERIES_COLOURS.length],
                    visible: true,
                  },
                ],
              })
            }
          >
            <IconPlus size={13} /> Add a plane
          </Button>
        )}
      </Collapsible>

      <Collapsible title="Intersection">
        {!analysis && <Callout>Show two or three planes to see where they meet.</Callout>}

        {analysis?.kind === 'point' && (
          <>
            <Callout>The three planes meet at exactly one point — the system has a unique solution.</Callout>
            <StatList>
              <Stat label="x" value={fmt(analysis.point[0], 8)} emphasis />
              <Stat label="y" value={fmt(analysis.point[1], 8)} emphasis />
              <Stat label="z" value={fmt(analysis.point[2], 8)} emphasis />
            </StatList>
          </>
        )}

        {analysis?.kind === 'line' && (
          <>
            <Callout>
              They meet in a line, so the system has infinitely many solutions — one free parameter.
            </Callout>
            <StatList>
              <Stat label="through" value={analysis.point.map((v) => fmt(v, 4)).join(', ')} />
              <Stat label="direction" value={analysis.direction.map((v) => fmt(v, 4)).join(', ')} />
              {'angle' in analysis && (
                <Stat
                  label="angle between"
                  value={`${fmt(((analysis as { angle: number }).angle * 180) / Math.PI, 4)}°`}
                />
              )}
            </StatList>
          </>
        )}

        {analysis?.kind === 'parallel' && (
          <>
            <Callout kind="warn">The planes are parallel and never meet — the system is inconsistent.</Callout>
            <StatList>
              <Stat label="distance apart" value={fmt(analysis.distance)} />
            </StatList>
          </>
        )}

        {analysis?.kind === 'coincident' && (
          <Callout kind="warn">These are the same plane written two ways — the equations are dependent.</Callout>
        )}

        {analysis?.kind === 'plane' && (
          <Callout kind="warn">
            All the planes coincide, so the solution set is a whole plane: two free parameters.
          </Callout>
        )}

        {analysis?.kind === 'none' && <Callout kind="warn">{analysis.reason}</Callout>}
      </Collapsible>
    </>
  );
}

function CalculatorPanel({ cfg }: { cfg: LinAlgConfig }) {
  const setLinAlg = useStore((s) => s.setLinAlg);
  const m = cfg.calcMatrix;
  const rows = m.length;
  const cols = m[0]?.length ?? 0;
  const square = rows === cols;

  const results = useMemo(() => {
    const augmented = m.map((row, i) => [...row, cfg.calcVector[i] ?? 0]);
    const r = rref(augmented);
    const inv = square ? inverse(m) : null;
    const e = square ? eigen(m) : null;
    return {
      det: square ? determinant(m) : null,
      rank: rank(m),
      augRank: r.rank,
      rref: r,
      inverse: inv,
      eigen: e,
      transpose: transpose(m),
      solution: inv ? apply(inv, cfg.calcVector) : null,
    };
  }, [m, cfg.calcVector, square]);

  const resize = (nextRows: number, nextCols: number) => {
    const next: number[][] = [];
    for (let i = 0; i < nextRows; i++) {
      next.push(Array.from({ length: nextCols }, (_, j) => m[i]?.[j] ?? (i === j ? 1 : 0)));
    }
    setLinAlg({
      calcMatrix: next,
      calcVector: Array.from({ length: nextRows }, (_, i) => cfg.calcVector[i] ?? 0),
    });
  };

  return (
    <>
      <Collapsible title="Matrix">
        <Row>
          <div className="flex-1">
            <span className="field-label">Rows</span>
            <NumberField
              value={rows}
              min={1}
              max={6}
              step={1}
              onChange={(v) => resize(Math.round(v), cols)}
            />
          </div>
          <div className="flex-1">
            <span className="field-label">Columns</span>
            <NumberField
              value={cols}
              min={1}
              max={6}
              step={1}
              onChange={(v) => resize(rows, Math.round(v))}
            />
          </div>
        </Row>
        <MatrixEditor matrix={m} onChange={(calcMatrix) => setLinAlg({ calcMatrix })} />

        <Field label="Right-hand side b" hint="Used for solving Ax = b and for the augmented reduction.">
          <div className="flex gap-1">
            {cfg.calcVector.slice(0, rows).map((v, i) => (
              <NumberField
                key={i}
                className="flex-1"
                value={v}
                step={0.5}
                onChange={(next) =>
                  setLinAlg({ calcVector: cfg.calcVector.map((w, j) => (j === i ? next : w)) })
                }
              />
            ))}
          </div>
        </Field>
      </Collapsible>

      <Collapsible title="Results">
        <StatList>
          {results.det !== null && <Stat label="Determinant" value={fmt(results.det, 8)} emphasis />}
          <Stat label="Rank" value={String(results.rank)} />
          <Stat label="Rank of [A|b]" value={String(results.augRank)} />
          {square && <Stat label="Trace" value={fmt(trace(m))} />}
          {square && <Stat label="Condition" value={fmt(conditionNumber(m))} />}
        </StatList>

        <Callout kind={results.augRank > results.rank ? 'warn' : 'info'}>
          {results.augRank > results.rank
            ? 'rank(A) < rank([A|b]): the system is inconsistent and has no solution.'
            : results.rank < cols
              ? `rank(A) = ${results.rank} < ${cols} unknowns, so the solution set has ${cols - results.rank} free parameter${cols - results.rank === 1 ? '' : 's'}.`
              : 'The system has a unique solution.'}
        </Callout>

        {results.solution && (
          <div>
            <p className="field-label mb-1">Solution of Ax = b</p>
            <div className="space-y-0.5 font-mono text-xs">
              {results.solution.map((v, i) => (
                <p key={i} className="text-ink">
                  x{subscript(i + 1)} = {fmt(v, 8)}
                </p>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="field-label mb-1">Reduced row echelon form of [A|b]</p>
          <MatrixDisplay matrix={results.rref.matrix} highlight={(i, j) => results.rref.pivots[i] === j} />
        </div>

        <Toggle
          label="Show the elimination steps"
          checked={cfg.showRrefSteps}
          onChange={(showRrefSteps) => setLinAlg({ showRrefSteps })}
        />
        {cfg.showRrefSteps && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border border-edge bg-surface-1 p-2 font-mono text-2xs text-ink-dim">
            {results.rref.steps.length ? (
              results.rref.steps.map((s, i) => <p key={i}>{s}</p>)
            ) : (
              <p>Already in reduced form.</p>
            )}
          </div>
        )}

        {results.inverse && (
          <div>
            <p className="field-label mb-1">Inverse</p>
            <MatrixDisplay matrix={results.inverse} />
          </div>
        )}

        {results.eigen && (
          <div>
            <p className="field-label mb-1">Eigenvalues</p>
            {results.eigen.values.map((v, i) => (
              <p key={i} className="font-mono text-xs text-ink">
                λ{subscript(i + 1)} ={' '}
                {Math.abs(v.im) < 1e-10
                  ? fmt(v.re, 8)
                  : `${fmt(v.re, 6)} ${v.im >= 0 ? '+' : '−'} ${fmt(Math.abs(v.im), 6)}i`}
              </p>
            ))}
          </div>
        )}

        <div>
          <p className="field-label mb-1">Transpose</p>
          <MatrixDisplay matrix={results.transpose} />
        </div>
      </Collapsible>
    </>
  );
}

function subscript(n: number): string {
  return String(n)
    .split('')
    .map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
    .join('');
}

/* ------------------------------------------------------------------ surface */

export function LinearAlgebraSurface({ tab }: { tab: TabState }) {
  const cfg = tab.linalg;
  if (cfg.view === 'transform2d') return <Transform2DSurface tab={tab} />;
  if (cfg.view === 'calculator') return <CalculatorSurface tab={tab} />;
  return <Scene3DSurface tab={tab} />;
}

function Transform2DSurface({ tab }: { tab: TabState }) {
  const setViewport = useStore((s) => s.setViewport);
  const plotRef = usePlot2DRef();
  const cfg = tab.linalg;
  const progress = effectiveProgress(tab);

  const scene = useMemo<PlotScene>(() => {
    const m = interpolateFromIdentity(cfg.matrix2, progress);
    const layers: Layer[] = [];
    const v = tab.viewport;

    if (cfg.showGrid) {
      // The transformed grid is the clearest single picture of what a matrix
      // does: straight lines stay straight, parallel lines stay parallel, and
      // the origin stays put.
      const extent = Math.ceil(Math.max(Math.abs(v.xMin), Math.abs(v.xMax), Math.abs(v.yMin), Math.abs(v.yMax))) + 6;
      const data: number[] = [];
      for (let i = -extent; i <= extent; i++) {
        const a = apply(m, [i, -extent]);
        const b = apply(m, [i, extent]);
        data.push(a[0], a[1], b[0], b[1]);
        const c = apply(m, [-extent, i]);
        const d = apply(m, [extent, i]);
        data.push(c[0], c[1], d[0], d[1]);
      }
      layers.push({
        type: 'segments',
        data: Float64Array.from(data),
        colour: 'rgba(139,124,246,0.30)',
        width: 1,
      });
    }

    if (cfg.showUnitSquare) {
      const corners = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].map((p) => apply(m, p));
      layers.push({
        type: 'polyline',
        xs: corners.map((p) => p[0]),
        ys: corners.map((p) => p[1]),
        colour: '#fbbf24',
        width: 1.6,
        closed: true,
        fill: 'rgba(251,191,36,0.16)',
      });
      const det = determinant(m);
      const centre = corners.reduce((acc, p) => [acc[0] + p[0] / 4, acc[1] + p[1] / 4], [0, 0]);
      layers.push({
        type: 'text',
        x: centre[0],
        y: centre[1],
        text: `det = ${fmt(det, 4)}`,
        colour: '#fbbf24',
        align: 'center',
        size: 12,
        background: 'rgba(11,13,18,0.8)',
      });
    }

    if (cfg.showEigenvectors) {
      const e = eigen(cfg.matrix2);
      e.vectors.forEach((vec, i) => {
        if (!vec || Math.abs(e.values[i].im) > 1e-12) return;
        const span = 40;
        layers.push({
          type: 'polyline',
          xs: [-vec[0] * span, vec[0] * span],
          ys: [-vec[1] * span, vec[1] * span],
          colour: '#fb7185',
          width: 1.2,
          style: 'dashed',
          alpha: 0.8,
        });
        // The eigenvector is drawn scaled by its own eigenvalue, so the arrow
        // literally shows the stretch the matrix applies along that direction.
        const scaled = 1 + (e.values[i].re - 1) * progress;
        layers.push({
          type: 'polyline',
          xs: [0, vec[0] * scaled * 2],
          ys: [0, vec[1] * scaled * 2],
          colour: '#fb7185',
          width: 2.4,
        });
        layers.push({
          type: 'marker',
          x: vec[0] * scaled * 2,
          y: vec[1] * scaled * 2,
          label: `λ = ${fmt(e.values[i].re, 4)}`,
          colour: '#fb7185',
        });
      });
    }

    // Basis vectors: the columns of the matrix, which is what they become.
    const i2 = apply(m, [1, 0]);
    const j2 = apply(m, [0, 1]);
    layers.push({ type: 'polyline', xs: [0, i2[0]], ys: [0, i2[1]], colour: '#34d399', width: 3 });
    layers.push({ type: 'marker', x: i2[0], y: i2[1], label: `î (${fmt(i2[0], 3)}, ${fmt(i2[1], 3)})`, colour: '#34d399' });
    layers.push({ type: 'polyline', xs: [0, j2[0]], ys: [0, j2[1]], colour: '#38bdf8', width: 3 });
    layers.push({ type: 'marker', x: j2[0], y: j2[1], label: `ĵ (${fmt(j2[0], 3)}, ${fmt(j2[1], 3)})`, colour: '#38bdf8' });

    for (const vec of cfg.vectors) {
      const out = apply(m, vec.v);
      layers.push({ type: 'polyline', xs: [0, out[0]], ys: [0, out[1]], colour: vec.colour, width: 2.4 });
      layers.push({
        type: 'marker',
        x: out[0],
        y: out[1],
        label: `${vec.label} (${fmt(out[0], 3)}, ${fmt(out[1], 3)})`,
        colour: vec.colour,
      });
      layers.push({
        type: 'polyline',
        xs: [0, vec.v[0]],
        ys: [0, vec.v[1]],
        colour: vec.colour,
        width: 1,
        style: 'dotted',
        alpha: 0.5,
      });
    }

    return {
      viewport: tab.viewport,
      layers,
      showGrid: tab.showGrid,
      showMinorGrid: false,
      showAxes: tab.showAxes,
      xLabel: 'x',
      yLabel: 'y',
      caption: `t = ${progress.toFixed(2)}`,
    };
  }, [cfg, progress, tab.viewport, tab.showGrid, tab.showAxes]);

  return <Plot2D ref={plotRef} scene={scene} onViewportChange={setViewport} showCrosshair={tab.showCrosshair} />;
}

function Scene3DSurface({ tab }: { tab: TabState }) {
  const patchActive = useStore((s) => s.patchActive);
  const plotRef = usePlotRef();
  const cfg = tab.linalg;

  const build = ({ content }: { content: THREE.Group }) => {
    addAxes(content, 5);

    if (cfg.view === 'transform3d') {
      const m = interpolateFromIdentity(cfg.matrix3, cfg.progress);
      const toVec = (p: number[]) => {
        const q = apply(m, p);
        // three.js is y-up; the maths here is z-up, so the axes are swapped
        // at the boundary rather than throughout the linear algebra.
        return new THREE.Vector3(q[0], q[2], q[1]);
      };

      if (cfg.showGrid) {
        const positions: number[] = [];
        const n = 3;
        for (let i = -n; i <= n; i++) {
          for (let j = -n; j <= n; j++) {
            const push = (a: number[], b: number[]) => {
              const p = toVec(a);
              const q = toVec(b);
              positions.push(p.x, p.y, p.z, q.x, q.y, q.z);
            };
            push([i, j, -n], [i, j, n]);
            push([i, -n, j], [i, n, j]);
            push([-n, i, j], [n, i, j]);
          }
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        content.add(
          new THREE.LineSegments(
            geometry,
            new THREE.LineBasicMaterial({ color: 0x8b7cf6, transparent: true, opacity: 0.16 }),
          ),
        );
      }

      // The transformed unit cube, whose volume is the determinant.
      const cubeCorners = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
      ];
      const edges = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      const cubePositions: number[] = [];
      for (const [a, b] of edges) {
        const p = toVec(cubeCorners[a]);
        const q = toVec(cubeCorners[b]);
        cubePositions.push(p.x, p.y, p.z, q.x, q.y, q.z);
      }
      const cubeGeometry = new THREE.BufferGeometry();
      cubeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(cubePositions, 3));
      content.add(new THREE.LineSegments(cubeGeometry, new THREE.LineBasicMaterial({ color: 0xfbbf24 })));

      const basisColours = [0xfb7185, 0x34d399, 0x38bdf8];
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((b, i) => {
        content.add(makeVector(new THREE.Vector3(0, 0, 0), toVec(b), basisColours[i], 0.045));
      });
    } else {
      // ---- planes
      const visible = cfg.planes.filter((p) => p.visible);
      for (const plane of visible) {
        const normal = new THREE.Vector3(plane.a, plane.c, plane.b);
        const length = normal.length();
        if (length < 1e-9) continue;
        const geometry = new THREE.PlaneGeometry(7.5, 7.5, 1, 1);
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(plane.colour),
          transparent: true,
          opacity: 0.32,
          side: THREE.DoubleSide,
          roughness: 0.7,
          metalness: 0,
        });
        const mesh = new THREE.Mesh(geometry, material);
        // A PlaneGeometry faces +z; rotating that onto the plane's normal and
        // then pushing it out by d/|n| places it exactly.
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
        mesh.position.copy(normal.clone().normalize().multiplyScalar(plane.d / length));
        content.add(mesh);

        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: new THREE.Color(plane.colour), transparent: true, opacity: 0.8 }),
        );
        outline.quaternion.copy(mesh.quaternion);
        outline.position.copy(mesh.position);
        content.add(outline);
      }

      if (visible.length >= 2) {
        const pairResult = intersectPlanes(visible[0], visible[1]);
        if (pairResult.kind === 'line' && visible.length === 2) {
          drawLine(content, pairResult.point, pairResult.direction, 0xfbbf24);
        }
      }
      if (visible.length === 3) {
        const result = intersectThreePlanes(visible[0], visible[1], visible[2]);
        if (result.kind === 'point') {
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.14, 24, 18),
            new THREE.MeshStandardMaterial({ color: 0xfbbf24, emissive: 0x5a4200 }),
          );
          sphere.position.set(result.point[0], result.point[2], result.point[1]);
          content.add(sphere);
          const label = makeLabel(
            `(${fmt(result.point[0], 4)}, ${fmt(result.point[1], 4)}, ${fmt(result.point[2], 4)})`,
            '#fbbf24',
            0.34,
          );
          if (label) {
            label.position.set(result.point[0], result.point[2] + 0.45, result.point[1]);
            content.add(label);
          }
        } else if (result.kind === 'line') {
          drawLine(content, result.point, result.direction, 0xfbbf24);
        }
      }
    }
  };

  return (
    <Scene3D
      ref={plotRef}
      build={build}
      deps={[cfg.view, JSON.stringify(cfg.matrix3), cfg.progress, cfg.showGrid, JSON.stringify(cfg.planes)]}
      camera={tab.camera}
      onCameraChange={(camera) => patchActive({ camera })}
    />
  );
}

function drawLine(content: THREE.Group, point: number[], direction: number[], colour: number): void {
  const span = 7;
  const p = new THREE.Vector3(point[0], point[2], point[1]);
  const d = new THREE.Vector3(direction[0], direction[2], direction[1]).normalize();
  const geometry = new THREE.BufferGeometry().setFromPoints([
    p.clone().add(d.clone().multiplyScalar(-span)),
    p.clone().add(d.clone().multiplyScalar(span)),
  ]);
  content.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: colour, linewidth: 2 })));
  const tube = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, span * 2, 10),
    new THREE.MeshStandardMaterial({ color: colour, emissive: 0x3a2b00 }),
  );
  tube.position.copy(p);
  tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  content.add(tube);
}

/** The calculator has no plot; it shows the matrix and its decompositions large. */
function CalculatorSurface({ tab }: { tab: TabState }) {
  const cfg = tab.linalg;
  const m = cfg.calcMatrix;
  const square = m.length === (m[0]?.length ?? 0);
  const inv = square ? inverse(m) : null;
  const e = square ? eigen(m) : null;
  const r = rref(m.map((row, i) => [...row, cfg.calcVector[i] ?? 0]));

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <Block title="A" subtitle={`${m.length} × ${m[0]?.length ?? 0}`}>
          <BigMatrix matrix={formatMatrix(m)} />
        </Block>

        <div className="grid grid-cols-2 gap-6">
          <Block title="Reduced row echelon form of [A | b]">
            <BigMatrix matrix={formatMatrix(r.matrix)} />
          </Block>
          {inv && (
            <Block title="A⁻¹">
              <BigMatrix matrix={formatMatrix(inv)} />
            </Block>
          )}
        </div>

        {e && (
          <Block title="Eigenvalues">
            <div className="flex flex-wrap gap-3">
              {e.values.map((v, i) => (
                <span key={i} className="rounded-md border border-edge bg-surface-2 px-3 py-1.5 font-mono text-sm text-ink">
                  {Math.abs(v.im) < 1e-10
                    ? fmt(v.re, 8)
                    : `${fmt(v.re, 6)} ${v.im >= 0 ? '+' : '−'} ${fmt(Math.abs(v.im), 6)}i`}
                </span>
              ))}
            </div>
          </Block>
        )}

        <Block title="Transpose">
          <BigMatrix matrix={formatMatrix(transpose(m))} />
        </Block>
      </div>
    </div>
  );
}

function Block({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-baseline gap-2 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
        {title}
        {subtitle && <span className="font-normal normal-case tracking-normal">{subtitle}</span>}
      </h3>
      {children}
    </section>
  );
}

function BigMatrix({ matrix }: { matrix: string[][] }) {
  return (
    <div className="inline-flex items-stretch gap-2 rounded-lg border border-edge bg-surface-2 p-3">
      <div className="w-2 rounded-sm border-y-2 border-l-2 border-edge-strong" />
      <div>
        {matrix.map((row, i) => (
          <div key={i} className="flex">
            {row.map((v, j) => (
              <span key={j} className="min-w-[5rem] px-2 py-1 text-right font-mono text-sm tabular-nums text-ink">
                {v}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="w-2 rounded-sm border-y-2 border-r-2 border-edge-strong" />
    </div>
  );
}

export function linAlgCsv(tab: TabState): string | null {
  const m = tab.linalg.view === 'calculator' ? tab.linalg.calcMatrix : tab.linalg.matrix2;
  return m.map((row) => row.join(',')).join('\n');
}
