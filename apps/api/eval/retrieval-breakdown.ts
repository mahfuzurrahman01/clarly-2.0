// P0.3 (docs/decisions/A0-production-readiness-plan.md): the retrieval phase
// breakdown section of the scorecard.
//
// WHY A SEPARATE FILE: the scorecard renderer is already long and is being
// edited concurrently for P0.1; more importantly, "retrieval p95 is 768ms" is
// a symptom and this is the diagnosis, which is a different job with a
// different lifetime. When retrieval is fixed the bar row stays forever and
// this section can be deleted without touching anything else.
//
// It reports p50 AND p95 per phase because the two answer different questions:
// a phase whose p50 is already over budget is a structural cost (every single
// turn pays it), while a phase that is cheap at p50 and expensive at p95 is a
// tail/variance problem (a cold connection, a queued request, a GC pause) with
// an entirely different fix.
import type { RetrievalPhaseTimings } from '../src/modules/retrieval/retrieval-timings';
import type { TurnRecord } from './types';

interface PhaseRow {
  label: string;
  /** null when no turn reported this phase — "not measured", never rendered as 0. */
  p50: number | null;
  p95: number | null;
  /** Share of the total-retrieval p95 this phase's p95 accounts for. The one number that says where to spend effort. */
  shareOfP95: number | null;
}

/** Phases in pipeline order, each with the fix that applies if it dominates. */
const PHASES: Array<{
  key: keyof RetrievalPhaseTimings;
  label: string;
}> = [
  { key: 'embedMs', label: 'query embed (remote HTTP)' },
  { key: 'embedHttpTtfbMs', label: '  ├─ to response headers' },
  { key: 'embedHttpBodyMs', label: '  └─ body read + parse' },
  { key: 'storeMs', label: 'vector store call (total)' },
  { key: 'vectorQueryMs', label: '  ├─ pgvector pass' },
  { key: 'lexicalQueryMs', label: '  ├─ tsvector pass' },
  { key: 'fusionMs', label: '  └─ RRF fusion' },
  { key: 'rerankMs', label: 'rerank' },
  { key: 'totalMs', label: 'TOTAL retrieval' },
];

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index] ?? null;
}

/**
 * Renders the phase table, or a one-line explanation of why it is empty.
 * Returns lines rather than a string so the caller splices it into its own
 * line array like every other scorecard section.
 */
export function renderRetrievalBreakdown(records: TurnRecord[]): string[] {
  const measured = records
    .map((record) => record.retrievalPhases)
    .filter((phases): phases is RetrievalPhaseTimings => phases !== undefined);

  if (measured.length === 0) {
    return [
      '## Retrieval phase breakdown',
      '',
      '_No phase timings recorded — every turn either short-circuited on_',
      '_KBNotIndexed or ran against an Embedder that does not report them._',
      '',
    ];
  }

  const totalP95 = percentile(
    measured.map((phases) => phases.totalMs),
    95,
  );

  const rows: PhaseRow[] = PHASES.map(({ key, label }) => {
    // A phase is "not measured" only when NO turn reported it (an undefined
    // optional). A phase that genuinely took 0ms on every turn — rerank with
    // the D4 flag off — is measured and must read 0, not blank.
    const values = measured
      .map((phases) => phases[key])
      .filter((value): value is number => typeof value === 'number');
    const p95 = percentile(values, 95);
    return {
      label,
      p50: percentile(values, 50),
      p95,
      shareOfP95: p95 !== null && totalP95 ? p95 / totalP95 : null,
    };
  });

  const fmt = (value: number | null) =>
    value === null ? '—' : `${Math.round(value)}ms`;
  const pct = (value: number | null) =>
    value === null ? '—' : `${(value * 100).toFixed(0)}%`;

  return [
    `## Retrieval phase breakdown (n=${measured.length} turns)`,
    '',
    '| Phase | p50 | p95 | share of retrieval p95 |',
    '|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${row.label} | ${fmt(row.p50)} | ${fmt(row.p95)} | ${pct(row.shareOfP95)} |`,
    ),
    '',
    'The share column is the whole point: the phase with the largest share is the',
    'only one worth optimising, and each phase has a different fix (remote embed →',
    'colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant',
    'flag). "to response headers" close to the full embed cost means the time is in',
    'the round trip and the remote host, not in transferring the vector back.',
    '',
  ];
}
