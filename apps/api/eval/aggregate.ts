// P0.1: multi-run aggregation. Pure functions only — no LLM, no I/O — so the
// thing that decides "this case is flaky" and "resolution moved" is itself
// unit-testable and cannot drift silently.
//
// WHY: a single eval run reports one number, and on identical code that number
// moved 96.2 / 93.3 / 96.2 with 13 / 12 / 8 failing cases and largely DIFFERENT
// cases failing each time. One number per run makes every improvement claim
// smaller than the noise band unfalsifiable. So: run the suite N times and
// report median with min–max, and classify each case by how it behaved ACROSS
// runs rather than in the run that happened to be last.
import type { Metrics } from './scoring';
import type { TurnRecord } from './types';

/** A metric's behaviour across runs. `values` is kept in run order for runs.json diffing. */
export interface Spread {
  median: number;
  min: number;
  max: number;
  values: number[];
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** null when there is nothing to summarise (e.g. recall@5 with no probed case in any run). */
export function toSpread(values: Array<number | null>): Spread | null {
  const present = values.filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return {
    median: median(present),
    min: Math.min(...present),
    max: Math.max(...present),
    values: present,
  };
}

/** Every numeric field of Metrics, summarised across runs. Keys mirror Metrics exactly. */
export type MetricSpreads = Partial<Record<keyof Metrics, Spread | null>>;

export function aggregateMetrics(perRun: Metrics[]): MetricSpreads {
  const keys = Object.keys(perRun[0] ?? {}) as Array<keyof Metrics>;
  const spreads: MetricSpreads = {};
  for (const key of keys) {
    spreads[key] = toSpread(perRun.map((metrics) => metrics[key]));
  }
  return spreads;
}

export type Stability = 'stable-pass' | 'stable-fail' | 'flaky';

export interface CaseStability {
  caseKey: string;
  corpus: string;
  question: string;
  note?: string;
  /** Deterministic pass/fail per run, in run order. */
  outcomes: boolean[];
  /** Failure strings per run (empty array for a run that passed). Kept per-run because a flaky case often fails for a DIFFERENT reason each time, and that difference is the diagnosis. */
  failuresByRun: string[][];
  stability: Stability;
}

/**
 * Identity of a case across runs. Prefers the key the runner stamped (corpus +
 * ordinal, stable even if two cases in a corpus share a question) and falls
 * back to corpus+question so older turns.jsonl files still classify.
 */
export function caseKeyOf(record: TurnRecord): string {
  return record.caseKey ?? `${record.corpus}::${record.question}`;
}

/**
 * @param runs one TurnRecord[] per run, in run order.
 * Returns one entry per case, in first-run order — a stable ordering makes two
 * dated runs.json files diffable line by line.
 */
export function classifyCases(runs: TurnRecord[][]): CaseStability[] {
  const byKey = new Map<string, CaseStability>();

  runs.forEach((records, runIndex) => {
    for (const record of records) {
      const key = caseKeyOf(record);
      const existing = byKey.get(key) ?? {
        caseKey: key,
        corpus: record.corpus,
        question: record.question,
        note: record.note,
        // Pre-fill any run this case was absent from, so outcome position
        // always equals run index even for a partial corpus selection.
        outcomes: Array<boolean>(runIndex).fill(true),
        failuresByRun: Array.from({ length: runIndex }, () => []),
        stability: 'stable-pass' as Stability,
      };
      existing.outcomes.push(record.deterministicPass);
      existing.failuresByRun.push(record.deterministicFailures);
      byKey.set(key, existing);
    }
  });

  return [...byKey.values()].map((entry) => ({
    ...entry,
    stability: entry.outcomes.every((passed) => passed)
      ? 'stable-pass'
      : entry.outcomes.every((passed) => !passed)
        ? 'stable-fail'
        : 'flaky',
  }));
}

export interface StabilitySummary {
  stablePass: number;
  stableFail: CaseStability[];
  flaky: CaseStability[];
}

export function summariseStability(cases: CaseStability[]): StabilitySummary {
  return {
    stablePass: cases.filter((entry) => entry.stability === 'stable-pass')
      .length,
    stableFail: cases.filter((entry) => entry.stability === 'stable-fail'),
    flaky: cases.filter((entry) => entry.stability === 'flaky'),
  };
}

/** `O X O` — the shape of a flaky case at a glance, run order preserved. */
export function outcomePattern(outcomes: boolean[]): string {
  return outcomes.map((passed) => (passed ? 'O' : 'X')).join(' ');
}
