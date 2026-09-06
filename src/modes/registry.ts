/* Every tab mode, in one table.
 *
 * A mode is nothing more than a pair of components — the sidebar controls and
 * the main surface — plus an optional CSV exporter. Keeping the mapping in a
 * single record means the shell contains no branching on mode at all, and
 * adding a mode touches exactly this file plus the type union.
 */

import type { ComponentType } from 'react';
import type { TabMode, TabState } from '../core/types';
import { GraphingPanel, GraphingSurface, graphingCsv } from './GraphingMode';
import { StatisticsPanel, StatisticsSurface, statisticsCsv } from './StatisticsMode';
import { LinearAlgebraPanel, LinearAlgebraSurface, linAlgCsv } from './LinearAlgebraMode';
import { MonteCarloPanel, MonteCarloSurface, monteCarloCsv } from './MonteCarloMode';
import { CalculusPanel, CalculusSurface, calculusCsv } from './CalculusMode';
import { DynamicsPanel, DynamicsSurface, dynamicsCsv } from './DynamicsMode';
import { FieldsPanel, FieldsSurface, fieldsCsv } from './FieldsMode';
import { FittingPanel, FittingSurface, fittingCsv } from './FittingMode';
import { MechanicsPanel, MechanicsSurface, mechanicsCsv } from './MechanicsMode';
import { CircuitPanel, CircuitSurface, circuitsCsv } from './CircuitMode';
import { QuantumPanel, QuantumSurface, quantumCsv } from './QuantumMode';
import { ChemistryPanel, ChemistrySurface, chemistryCsv } from './ChemistryMode';
import { WavesPanel, WavesSurface, wavesCsv } from './WavesMode';
import { SignalsPanel, SignalsSurface, signalsCsv } from './SignalsMode';
import { OptimisationPanel, OptimisationSurface, optimisationCsv } from './OptimisationMode';
import { ReactionsPanel, ReactionsSurface, reactionsCsv } from './ReactionsMode';
import { ThermodynamicsPanel, ThermodynamicsSurface, thermoCsv } from './ThermodynamicsMode';

export interface ModeModule {
  Panel: ComponentType<{ tab: TabState }>;
  Surface: ComponentType<{ tab: TabState }>;
  /** Returns the tab's data as CSV, or null when there is nothing tabular. */
  toCsv?: (tab: TabState) => string | null;
}

export const MODE_REGISTRY: Record<TabMode, ModeModule> = {
  graphing: { Panel: GraphingPanel, Surface: GraphingSurface, toCsv: graphingCsv },
  statistics: { Panel: StatisticsPanel, Surface: StatisticsSurface, toCsv: statisticsCsv },
  'linear-algebra': { Panel: LinearAlgebraPanel, Surface: LinearAlgebraSurface, toCsv: linAlgCsv },
  'monte-carlo': { Panel: MonteCarloPanel, Surface: MonteCarloSurface, toCsv: monteCarloCsv },
  calculus: { Panel: CalculusPanel, Surface: CalculusSurface, toCsv: calculusCsv },
  dynamics: { Panel: DynamicsPanel, Surface: DynamicsSurface, toCsv: dynamicsCsv },
  fields: { Panel: FieldsPanel, Surface: FieldsSurface, toCsv: fieldsCsv },
  fitting: { Panel: FittingPanel, Surface: FittingSurface, toCsv: fittingCsv },
  mechanics: { Panel: MechanicsPanel, Surface: MechanicsSurface, toCsv: mechanicsCsv },
  circuits: { Panel: CircuitPanel, Surface: CircuitSurface, toCsv: circuitsCsv },
  quantum: { Panel: QuantumPanel, Surface: QuantumSurface, toCsv: quantumCsv },
  chemistry: { Panel: ChemistryPanel, Surface: ChemistrySurface, toCsv: () => chemistryCsv() },
  waves: { Panel: WavesPanel, Surface: WavesSurface, toCsv: wavesCsv },
  signals: { Panel: SignalsPanel, Surface: SignalsSurface, toCsv: signalsCsv },
  optimisation: { Panel: OptimisationPanel, Surface: OptimisationSurface, toCsv: optimisationCsv },
  reactions: { Panel: ReactionsPanel, Surface: ReactionsSurface, toCsv: reactionsCsv },
  thermodynamics: { Panel: ThermodynamicsPanel, Surface: ThermodynamicsSurface, toCsv: thermoCsv },
};
