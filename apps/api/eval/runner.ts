/**
 * Agent quality eval harness.
 *
 *   npm run eval --workspace=api            # all corpora
 *   npm run eval --workspace=api -- --corpus refund-policy
 *   npm run eval --workspace=api -- --runs 5    # P0.1: median + min-max spread
 *
 * Drives the REAL AgentRuntime against a REAL Postgres with REAL Gemini,
 * embeddings and Cohere rerank — the same objects that serve production
 * traffic. Nothing is stubbed, because the questions being asked (is the
 * confidence calibrated? does it hallucinate? does it resist injection?) are
 * precisely the ones a stub cannot answer.
 *
 * Costs a small number of cents per full run and results vary slightly between
 * runs, which is why the scorecard reports a stability metric instead of
 * pretending the numbers are exact. Deliberately NOT wired into CI.
 *
 * P0.1 (docs/decisions/A0-production-readiness-plan.md): `--runs N` executes the
 * whole suite N times against the SAME throwaway tenants and the SAME ingested
 * KB — re-ingesting per run would cost minutes and embedding calls to re-create
 * a thing that does not vary — and reports every metric as a median with its
 * min–max spread. Three identical-code runs previously produced 96.2/93.3/96.2%
 * resolution with mostly different cases failing, which made every improvement
 * claim under ~3 points unfalsifiable. A run is a sample, not a measurement.
 *
 * Retrieval is measured with its own call, separate from the turn, so that a
 * poor resolution rate is attributable: "retrieval never returned the fact" and
 * "retrieval had the fact and the agent still escalated" are different bugs
 * with different fixes.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { AgentRuntime } from '../src/modules/agent/agent-runtime';
import {
  LlmProvider,
  VisionLlmProvider,
} from '../src/modules/llm/ports/llm-provider.port';
import {
  kbDocuments,
  tenants,
} from '../src/modules/persistence/drizzle/schema';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { RetrievalIngestService } from '../src/modules/retrieval/retrieval-ingest.service';
import { RetrievalSearchService } from '../src/modules/retrieval/retrieval-search.service';
import { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';
import { TenantPolicyService } from '../src/modules/onboarding/tenant-policy.service';
// L2 (commerce tool eval): the real repositories/services fixtures.ts and
// this runner seed and read through — never a parallel mock.
import { CatalogService } from '../src/modules/catalog/catalog.service';
import { CatalogToolSeederService } from '../src/modules/catalog/catalog-tool-seeder.service';
import { CustomerService } from '../src/modules/customer/customer.service';
import { ConversationService } from '../src/modules/conversation/conversation.service';
import { CourierConnectionService } from '../src/modules/courier/courier-connection.service';
import { CourierToolSeederService } from '../src/modules/courier/courier-tool-seeder.service';
import { ShipmentService } from '../src/modules/courier/shipment.service';
import { OrderService } from '../src/modules/order/order.service';
import { OrderApprovalService } from '../src/modules/order/order-approval.service';
import { OrderSettingsService } from '../src/modules/order/order-settings.service';
import { OrderToolSeederService } from '../src/modules/order/order-tool-seeder.service';
import { ToolExecutionService } from '../src/modules/tool-execution/tool-execution.service';
import { TenantToolRegistryService } from '../src/modules/tool-registry/tenant-tool-registry.service';
import {
  findExistingOrderIdsForConversation,
  retireEvalPendingOrders,
  findNewOrderForConversation,
  seedFixtures,
  type CorpusFixtures,
  type SeededFixtures,
} from './fixtures';
import {
  ToolCallRecorder,
  instrumentToolExecution,
  wrapProviderForRoundTrips,
} from './tool-call-recorder';
import {
  TurnDiagnosticsRecorder,
  instrumentTurnDiagnostics,
} from './turn-diagnostics';
import { AnswerGroundingVerifierService } from '../src/modules/guardrail/answer-grounding-verifier.service';
import {
  aggregateMetrics,
  classifyCases,
  summariseStability,
} from './aggregate';
import {
  determinismNote,
  EVAL_TEMPERATURE,
  pinTemperature,
  resolveLlmConfig,
  temperaturePinningEnabled,
} from './determinism';
import { formatToolEvidence, judgeAnswer } from './judge';
import {
  computeMetrics,
  containsAnyOf,
  scoreDeterministic,
  sweepThresholds,
  type ActualOrder,
} from './scoring';
import { renderScorecard } from './scorecard';
import type { TurnMedia } from '../src/modules/agent/media/turn-media.dto';
import type { EvalCase, EvalTurn, TurnRecord } from './types';

const CORPORA_DIR = join(__dirname, 'corpora');
const RESULTS_DIR = join(__dirname, 'results');

/** Kept identical across corpora so the scorecard compares like with like. */
const EVAL_PERSONA =
  'You are a customer support assistant. Answer using the knowledge base. Be concise and factual.';

function confidenceThreshold(): number {
  const raw = process.env.EVAL_CONFIDENCE_THRESHOLD;
  return raw ? Number(raw) : 0.5;
}

/**
 * Cohere's TRIAL key allows 10 requests/minute, and this harness makes two
 * reranked calls per case (the standalone retrieval pass plus the agent turn).
 * Without spacing, most of a run comes back as 429s and every metric is noise.
 *
 * This is a real production constraint, not just an eval inconvenience: the
 * respond path calls the reranker on EVERY turn, so a trial key caps the whole
 * product at ~5 conversations/minute, and a 429 currently fails the turn rather
 * than degrading to un-reranked results.
 */
function throttleMs(): number {
  const raw = process.env.EVAL_THROTTLE_MS;
  if (raw) return Number(raw);
  const usingCohere = process.env.RERANK_PROVIDER === 'cohere';
  return usingCohere && rerankEnabled() ? 13_000 : 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `--runs N`. Defaults to 1 so the existing single-run workflow (and its
 * scorecard format) is untouched.
 */
function runCount(): number {
  const index = process.argv.indexOf('--runs');
  if (index === -1) return 1;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--runs expects a positive integer, got "${process.argv[index + 1]}"`,
    );
  }
  return parsed;
}

/** Eval-only: whether the standalone retrieval probe also reranks (default true). */
function probeRerankEnabled(): boolean {
  return process.env.EVAL_PROBE_RERANK !== 'false';
}

function rerankEnabled(): boolean {
  // Defaults true to match tenant_policy's DB default — the configuration
  // production actually runs, which is the one worth measuring.
  return process.env.EVAL_RERANK !== 'false';
}

/**
 * F17: the bytes for one case's attachments, read from the corpus's `media/`
 * directory. Loaded once at corpus load rather than per run — a fixture does
 * not vary between runs any more than an ingested KB does.
 */
type LoadedMedia = TurnMedia[];

async function loadCaseMedia(
  dir: string,
  evalCase: EvalCase,
): Promise<LoadedMedia> {
  if (!evalCase.media?.length) return [];
  return Promise.all(
    evalCase.media.map(async (attachment) => ({
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      // Deliberately NOT validated here: the media-unreadable corpus exists to
      // prove the production gate catches a lying mime type, and a harness that
      // pre-checked the fixtures would test itself instead of the agent.
      bytes: await readFile(join(dir, 'media', attachment.file)),
    })),
  );
}

/**
 * L2: the same per-attachment byte loading as `loadCaseMedia`, but for a
 * multi-turn case's per-turn `media` (commerce-journey's photo -> price ->
 * order -> confirm -> "where is it?" -> complaint). Returns one `LoadedMedia`
 * per turn, in turn order, empty for a turn with no attachment — indexed
 * identically to `evalCase.turns` so the runner can look a turn's bytes up
 * by its own index.
 */
async function loadCaseTurnMedia(
  dir: string,
  evalCase: EvalCase,
): Promise<LoadedMedia[]> {
  if (!evalCase.turns?.length) return [];
  return Promise.all(
    evalCase.turns.map(async (turn) => {
      if (!turn.media?.length) return [];
      return Promise.all(
        turn.media.map(async (attachment) => ({
          kind: attachment.kind,
          mimeType: attachment.mimeType,
          bytes: await readFile(join(dir, 'media', attachment.file)),
        })),
      );
    }),
  );
}

/** L2: a corpus's `fixtures.json`, when it has one. Absent for every pre-L2 corpus — seedFixtures() is simply never called for those. */
async function loadCorpusFixtures(dir: string): Promise<CorpusFixtures | null> {
  try {
    const raw = await readFile(join(dir, 'fixtures.json'), 'utf8');
    return JSON.parse(raw) as CorpusFixtures;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function loadCorpus(name: string): Promise<{
  cases: EvalCase[];
  media: LoadedMedia[];
  turnMedia: LoadedMedia[][];
  documents: Array<{ filename: string; content: Buffer }>;
  knowledgeBase: string;
  fixtures: CorpusFixtures | null;
}> {
  const dir = join(CORPORA_DIR, name);
  const entries = await readdir(dir);

  const cases = JSON.parse(
    await readFile(join(dir, 'cases.json'), 'utf8'),
  ) as EvalCase[];

  const media = await Promise.all(
    cases.map((evalCase) => loadCaseMedia(dir, evalCase)),
  );
  const turnMedia = await Promise.all(
    cases.map((evalCase) => loadCaseTurnMedia(dir, evalCase)),
  );

  const documents = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.txt'))
      .sort()
      .map(async (filename) => ({
        filename,
        content: await readFile(join(dir, filename)),
      })),
  );

  const fixtures = await loadCorpusFixtures(dir);

  return {
    cases,
    media,
    turnMedia,
    documents,
    fixtures,
    knowledgeBase: documents
      .map((doc) => `--- ${doc.filename} ---\n${doc.content.toString('utf8')}`)
      .join('\n\n'),
  };
}

async function main(): Promise<void> {
  const only = process.argv.includes('--corpus')
    ? process.argv[process.argv.indexOf('--corpus') + 1]
    : null;

  const allDirs = (await readdir(CORPORA_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !only || name === only)
    .sort();

  const corpora: string[] = [];
  for (const name of allDirs) {
    try {
      await readFile(join(CORPORA_DIR, name, 'cases.json'), 'utf8');
      corpora.push(name);
    } catch {
      console.log(`eval: skipping ${name} (no cases.json)`);
    }
  }

  if (corpora.length === 0) {
    throw new Error(`No corpora found${only ? ` matching "${only}"` : ''}.`);
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const persistence = app.get(PersistenceService);
  const tenantContext = app.get(TenantContextService);
  const tenantPolicy = app.get(TenantPolicyService);
  const ingest = app.get(RetrievalIngestService);
  const search = app.get(RetrievalSearchService);
  const agent = app.get(AgentRuntime);
  const llm = app.get(LlmProvider);
  const visionLlm = app.get(VisionLlmProvider);
  const conversations = app.get(ConversationService);
  const customers = app.get(CustomerService);
  const toolExecutionService = app.get(ToolExecutionService);

  // L2: the fixture-seeding services, bundled once for fixtures.ts's
  // seedFixtures() — the real repositories/services the respond path itself
  // writes through, never a parallel mock.
  const fixtureServices = {
    catalog: app.get(CatalogService),
    catalogToolSeeder: app.get(CatalogToolSeederService),
    customers,
    orders: app.get(OrderService),
    orderApproval: app.get(OrderApprovalService),
    orderSettings: app.get(OrderSettingsService),
    orderToolSeeder: app.get(OrderToolSeederService),
    courierConnections: app.get(CourierConnectionService),
    courierToolSeeder: app.get(CourierToolSeederService),
    shipments: app.get(ShipmentService),
    tenantContext,
    toolRegistry: app.get(TenantToolRegistryService),
  };

  // L2: every tool call any turn makes is captured here — one recorder
  // "current" at a time, swapped in immediately before each turn (the harness
  // runs cases strictly sequentially; see the throttle/await in the case
  // loop below), and read back right after. See tool-call-recorder.ts's own
  // header for why this is safe against the shared-singleton services the
  // real app also uses.
  let currentRecorder: ToolCallRecorder | null = null;
  const toolInstrumentation = instrumentToolExecution(toolExecutionService);
  const restoreLlmRoundTrips = wrapProviderForRoundTrips(
    llm,
    () => currentRecorder,
  );
  const restoreVisionRoundTrips = wrapProviderForRoundTrips(
    visionLlm,
    () => currentRecorder,
  );
  // Eval-only: the respond drafts and A6 verifier inputs/verdicts per turn,
  // so a guard override can be read rather than inferred (turn-diagnostics.ts).
  let currentDiagnostics: TurnDiagnosticsRecorder | null = null;
  const restoreDiagnostics = instrumentTurnDiagnostics(
    app.get(AnswerGroundingVerifierService),
    visionLlm === llm ? [llm] : [llm, visionLlm],
    () => currentDiagnostics,
  );

  const threshold = confidenceThreshold();
  const rerank = rerankEnabled();
  const throttle = throttleMs();
  const runs = runCount();
  const pinned = temperaturePinningEnabled();

  // P0.1: eval-only greedy decoding, applied to the container's singleton
  // provider instance. Nothing in src/ changes; see determinism.ts.
  if (pinned) pinTemperature(llm, EVAL_TEMPERATURE);

  /** One TurnRecord[] per run, kept separate — pooling them would erase exactly the per-run variance this is measuring. */
  const runRecords: TurnRecord[][] = [];
  const createdTenantIds: string[] = [];

  console.log(
    `eval: ${corpora.length} corpora | threshold ${threshold} | rerank ${rerank ? 'on' : 'off'} | ${process.env.RERANK_PROVIDER ?? 'none'}${throttle ? ` | throttle ${throttle}ms/case` : ''}` +
      ` | runs ${runs} | temperature ${pinned ? String(EVAL_TEMPERATURE) : 'unpinned'}\n`,
  );

  try {
    // --- setup, ONCE for the whole invocation ---
    // Tenants and their ingested KB are shared across runs: the KB is not what
    // varies between runs, and re-ingesting per run would burn minutes and
    // embedding calls to rebuild an identical index.
    const prepared = await Promise.all(
      corpora.map(async (corpus) => {
        const { cases, media, turnMedia, documents, knowledgeBase, fixtures } =
          await loadCorpus(corpus);
        return {
          corpus,
          cases,
          media,
          turnMedia,
          documents,
          knowledgeBase,
          fixtures,
        };
      }),
    );

    const tenantIdByCorpus = new Map<string, string>();
    // L2: only populated for a corpus that ships a fixtures.json.
    const seededFixturesByCorpus = new Map<string, SeededFixtures>();
    for (const { corpus, documents, fixtures } of prepared) {
      // A throwaway tenant per corpus — the only way to guarantee one corpus's
      // KB cannot leak into another's retrieval.
      const {
        rows: [tenant],
      } = await persistence.runAdminQuery((db) =>
        db.execute<{ id: string }>(
          // `tenants` has no `phone` column (see tenants.table.ts) — it never
          // has, in any migration. A prior version of this insert named one
          // anyway, which failed every run before a single case could execute.
          sql`INSERT INTO tenants (name) VALUES (${'eval-' + corpus}) RETURNING id`,
        ),
      );
      createdTenantIds.push(tenant.id);
      tenantIdByCorpus.set(corpus, tenant.id);
      await tenantPolicy.upsert(tenant.id, {
        confidenceThreshold: threshold,
        rerankEnabled: rerank,
        tonePersonaOverride: EVAL_PERSONA,
      });

      for (const doc of documents) {
        const kbDocumentId = randomUUID();
        await tenantContext.withTenantTx(
          (tx) =>
            tx.insert(kbDocuments).values({
              id: kbDocumentId,
              tenantId: tenant.id,
              filename: doc.filename,
              storageKey: `${tenant.id}/${kbDocumentId}`,
              mimeType: 'text/plain',
              sizeBytes: doc.content.byteLength,
              status: 'uploaded',
            }),
          tenant.id,
        );
        await ingest.ingestDocument({
          tenantId: tenant.id,
          kbDocumentId,
          content: doc.content,
          mimeType: 'text/plain',
        });
      }

      // L2: seeded ALONGSIDE the KB, once per corpus, for the same reason the
      // KB itself is set up here rather than per-run — fixtures do not vary
      // between `--runs N` repeats.
      if (fixtures) {
        const seeded = await seedFixtures(fixtureServices, tenant.id, fixtures);
        seededFixturesByCorpus.set(corpus, seeded);
      }
    }

    // --- the suite, N times ---
    for (let runIndex = 1; runIndex <= runs; runIndex++) {
      const records: TurnRecord[] = [];
      if (runs > 1) console.log(`run ${runIndex}/${runs}`);

      for (const {
        corpus,
        cases,
        media,
        turnMedia,
        knowledgeBase,
      } of prepared) {
        const tenantId = tenantIdByCorpus.get(corpus)!;
        const seededFixtures = seededFixturesByCorpus.get(corpus) ?? null;
        process.stdout.write(`${corpus.padEnd(22)}`);

        let firstCase = true;
        for (const [ordinal, evalCase] of cases.entries()) {
          // Spacing, not concurrency — see throttleMs().
          if (throttle && !firstCase) await sleep(throttle);
          firstCase = false;

          const turnRecords = await runEvalCase({
            corpus,
            ordinal,
            runIndex,
            evalCase,
            media: media[ordinal],
            turnMedia: turnMedia[ordinal],
            tenantId,
            threshold,
            rerank,
            search,
            agent,
            llm,
            knowledgeBase,
            conversations,
            customers,
            seededFixtures,
            toolInstrumentation,
            setCurrentRecorder: (recorder) => {
              currentRecorder = recorder;
            },
            setCurrentDiagnostics: (diagnostics) => {
              currentDiagnostics = diagnostics;
            },
            tenantContext,
          });

          for (const record of turnRecords) {
            record.runIndex = runIndex;
            records.push(record);
            process.stdout.write(record.deterministicPass ? '.' : 'F');
          }
        }
        process.stdout.write('\n');
      }

      runRecords.push(records);
    }
  } finally {
    // L2: unwrap the shared singletons before the app context closes — never
    // strictly required (the whole process exits right after), but leaving a
    // production singleton monkey-patched is the wrong default to leave
    // lying around in a process that outlives this function (e.g. --runs
    // invoked from a longer-lived script).
    toolInstrumentation.restore();
    restoreLlmRoundTrips();
    restoreVisionRoundTrips();
    restoreDiagnostics();

    // Cascade removes kb_documents, kb_chunks, conversations and agent_runs.
    for (const tenantId of createdTenantIds) {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(eq(tenants.id, tenantId)),
      );
    }
    await app.close();
  }

  await writeResults({ runRecords, threshold, rerank, pinned });
}

/**
 * L2: runs one authored case end to end and returns one FULLY SCORED
 * `TurnRecord` per exchange — one record for a single-turn case, one per
 * entry in `evalCase.turns` for a multi-turn case (commerce-journey's
 * photo → price → order → confirm → "where is it?" → complaint).
 *
 * Identity (customer/conversation) is resolved ONCE per case and reused
 * across every turn of a multi-turn case — the same real conversation the
 * respond path would run, so `create_order`'s idempotency key and
 * `track_order`'s customer scoping are exercised for real rather than
 * bypassed. `history`/`summary` for turn N+1 are built from the ACTUAL
 * answers turns 1..N produced, never hand-authored.
 */
async function runEvalCase(args: {
  corpus: string;
  ordinal: number;
  /** 1-based `--runs N` repeat. Part of the turn id — see its use below. */
  runIndex: number;
  evalCase: EvalCase;
  media: TurnMedia[];
  turnMedia: LoadedMedia[];
  tenantId: string;
  threshold: number;
  rerank: boolean;
  search: RetrievalSearchService;
  agent: AgentRuntime;
  llm: LlmProvider;
  knowledgeBase: string;
  conversations: ConversationService;
  customers: CustomerService;
  seededFixtures: SeededFixtures | null;
  toolInstrumentation: ReturnType<typeof instrumentToolExecution>;
  setCurrentRecorder: (recorder: ToolCallRecorder | null) => void;
  setCurrentDiagnostics: (diagnostics: TurnDiagnosticsRecorder | null) => void;
  tenantContext: TenantContextService;
}): Promise<TurnRecord[]> {
  const {
    corpus,
    ordinal,
    runIndex,
    evalCase,
    media,
    turnMedia,
    tenantId,
    threshold,
    rerank,
    search,
    agent,
    llm,
    knowledgeBase,
    conversations,
    customers,
    seededFixtures,
    toolInstrumentation,
    setCurrentRecorder,
    setCurrentDiagnostics,
    tenantContext,
  } = args;

  // L2: the asking identity. `customerIndex` selects a fixture customer
  // (commerce-tracking's "another customer's order ref" cases set this to
  // the customer who does NOT own the order); a corpus with no fixtures, or
  // a case that never sets it, gets a stable per-case synthetic phone number
  // — every pre-L2 corpus's cases therefore get a real customer/conversation
  // too, harmlessly, since AgentTurnInput already accepted these fields.
  const customerIndex = evalCase.customerIndex ?? 0;
  const phone =
    seededFixtures?.customerPhones[customerIndex] ??
    `+1555eval${hashPhoneSuffix(corpus, ordinal)}`;
  const customerId =
    seededFixtures?.customerIds[customerIndex] ??
    (await customers.getOrCreateByPhone(tenantId, phone, 'whatsapp')).id;
  const conversation = await conversations.getOrCreateConversation(
    tenantId,
    phone,
    undefined,
    'whatsapp',
  );

  const preExistingOrderIds = (seededFixtures?.seededOrders ?? []).map(
    (order) => order.id,
  );
  // L2 `--runs N` isolation: a case run more than once reuses the SAME
  // conversation (same phone -> same conversation row every run), so an
  // order a REAL create_order call wrote in an earlier run is still on this
  // conversation when this run starts. Without baselining it here too,
  // `findNewOrderForConversation` would find that leftover order as "new"
  // for this run — see findExistingOrderIdsForConversation()'s own header.
  // Gated on `seededFixtures` (only commerce corpora carry a fixtures.json)
  // so every pre-L2 corpus, which never checks expectOrder/expectNoOrder,
  // pays no extra query per case.
  if (seededFixtures && runIndex > 1) {
    await retireEvalPendingOrders(
      tenantContext,
      tenantId,
      conversation.id,
      preExistingOrderIds,
    );
  }
  const excludeOrderIds = [
    ...preExistingOrderIds,
    ...(seededFixtures
      ? await findExistingOrderIdsForConversation(
          tenantContext,
          tenantId,
          conversation.id,
        )
      : []),
  ];

  const turns: EvalTurn[] = evalCase.turns ?? [
    {
      question: evalCase.question,
      messageText: evalCase.messageText,
      media: evalCase.media,
      expect: evalCase.expect,
      expectEscalationReason: evalCase.expectEscalationReason,
      expectEscalationDetail: evalCase.expectEscalationDetail,
      mustContain: evalCase.mustContain,
      mustNotContain: evalCase.mustNotContain,
      expectTools: evalCase.expectTools,
      expectToolArgs: evalCase.expectToolArgs,
      forbidTools: evalCase.forbidTools,
      expectOrder: evalCase.expectOrder,
      expectNoOrder: evalCase.expectNoOrder,
      expectedTotal: evalCase.expectedTotal,
      note: evalCase.note,
    },
  ];
  const isMultiTurn = !!evalCase.turns;

  let history = evalCase.turns ? [] : (evalCase.history ?? []);
  const summary = evalCase.turns ? null : (evalCase.summary ?? null);
  const results: TurnRecord[] = [];

  for (const [turnIndex, turn] of turns.entries()) {
    const recorder = new ToolCallRecorder();
    recorder.beginTurn();
    setCurrentRecorder(recorder);
    toolInstrumentation.setCurrent(recorder);
    const diagnostics = new TurnDiagnosticsRecorder();
    setCurrentDiagnostics(diagnostics);

    const record = await runSingleTurn({
      corpus,
      turn,
      media: isMultiTurn ? (turnMedia[turnIndex] ?? []) : media,
      tenantId,
      threshold,
      rerank,
      search,
      agent,
      customerId,
      conversationId: conversation.id,
      // Run index included: turnId is create_order's idempotency key, so a
      // repeat run reusing run 1's id gets run 1's order back ("re-read
      // (duplicate turn)") and every expectOrder case fails from run 2 on.
      turnId: `eval-${corpus}-${ordinal}-r${runIndex}-${turnIndex}`,
      history,
      summary,
      hasKnowledgeBase: knowledgeBase.length > 0,
    });

    setCurrentRecorder(null);
    toolInstrumentation.setCurrent(null);
    setCurrentDiagnostics(null);
    record.toolCalls = recorder.turnToolCalls();
    record.groundingChecks = diagnostics.groundingChecks();
    record.modelCalls = diagnostics.modelCallLog();
    record.caseKey = isMultiTurn
      ? `${corpus}#${ordinal}.${turnIndex}`
      : `${corpus}#${ordinal}`;
    if (isMultiTurn) record.turnIndex = turnIndex;
    record.hasExpectTools = !!turn.expectTools?.length;
    record.hasExpectToolArgs = !!turn.expectToolArgs;
    record.hasOrderExpectation = !!(turn.expectOrder || turn.expectNoOrder);
    record.hasOtherCustomerRefs = !!evalCase.otherCustomerRefs?.length;
    // H3a: lets computeMetrics() count refused attempts at forbidden tools.
    record.forbidTools = turn.forbidTools;

    let actualOrder: ActualOrder | null = null;
    if (record.hasOrderExpectation) {
      const found = await findNewOrderForConversation(
        tenantContext,
        tenantId,
        conversation.id,
        excludeOrderIds,
      );
      if (found) {
        // Excluded from every LATER turn's search in this same multi-turn
        // case, so a later expectNoOrder turn does not see turn N's order as
        // "new" again.
        const { id, ...order } = found;
        excludeOrderIds.push(id);
        actualOrder = order;
      }
    }

    record.deterministicFailures = scoreDeterministic(
      turnAsEvalCase(turn, evalCase.otherCustomerRefs),
      record,
      {
        catalogPrices: seededFixtures?.catalogPrices,
        actualOrder,
      },
    );
    record.deterministicPass = record.deterministicFailures.length === 0;

    if (!record.error && record.answer && turn.expect !== 'escalate') {
      const judged = await judgeAnswer(
        llm,
        knowledgeBase,
        turn.question,
        record.answer,
        formatToolEvidence(record.toolCalls),
        // H1: prior turns of a multi-turn case (or the case's authored
        // history), so a follow-up like "and the second one?" is judged in
        // context rather than as a standalone, unanswerable question.
        history,
        {
          mediaKinds: record.mediaKinds,
          expectedTotal: turn.expectedTotal,
        },
      );
      record.judgeVerdict = judged.verdict;
      record.judgeReason = judged.reason;
    } else {
      record.judgeVerdict = 'skipped';
    }

    results.push(record);

    // Carry the REAL exchange forward for the next turn of a multi-turn case.
    if (isMultiTurn) {
      history = [
        ...history,
        { role: 'user', content: turn.messageText ?? turn.question },
        { role: 'assistant', content: record.answer },
      ];
    }
  }

  return results;
}

/** A stable, non-secret per-case phone suffix — same case always gets the same synthetic customer, so re-running a corpus does not fragment one case across many customer rows. */
function hashPhoneSuffix(corpus: string, ordinal: number): string {
  let hash = 0;
  for (const char of corpus) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (
    String((hash % 900000) + 100000).padStart(6, '0') +
    String(ordinal).padStart(3, '0')
  );
}

/** EvalTurn carries everything scoreDeterministic() needs except `otherCustomerRefs`, which stays case-level (the same other-customer facts apply to every turn of a multi-turn conversation) — merged back in here for that one call. */
function turnAsEvalCase(
  turn: EvalTurn,
  otherCustomerRefs?: string[],
): EvalCase {
  return { ...turn, otherCustomerRefs };
}

async function runSingleTurn(args: {
  corpus: string;
  turn: EvalTurn;
  media: TurnMedia[];
  tenantId: string;
  threshold: number;
  rerank: boolean;
  search: RetrievalSearchService;
  agent: AgentRuntime;
  customerId: string;
  conversationId: string;
  turnId: string;
  history: Array<{
    role: 'user' | 'assistant' | 'human_agent';
    content: string;
  }>;
  summary: string | null;
  /** false for a tool-grounded corpus with no .txt documents: there is no index to probe, so recall is n/a rather than a false miss. */
  hasKnowledgeBase: boolean;
}): Promise<TurnRecord> {
  const {
    corpus,
    turn,
    media,
    tenantId,
    threshold,
    rerank,
    search,
    agent,
    customerId,
    conversationId,
    turnId,
    history,
    summary,
    hasKnowledgeBase,
  } = args;

  const record: TurnRecord = {
    corpus,
    question: turn.question,
    expect: turn.expect,
    note: turn.note,
    answer: '',
    escalated: false,
    escalationReason: null,
    escalationSource: null,
    escalationDetail: null,
    confidence: 0,
    citedChunkIds: [],
    isHallucination: false,
    promptVersion: '',
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    retrievalMs: 0,
    retrievedChunkIds: [],
    retrievedScores: [],
    recallHit: null,
    deterministicPass: false,
    deterministicFailures: [],
    toolCalls: [],
  };

  record.mediaKinds = media.map((item) => item.kind);

  // --- retrieval pass, measured on its own ---
  //
  // F17: skipped for a media case, on purpose. The query retrieval actually
  // runs for a photo or a voice note is the text the modality pre-pass derived
  // ("Acme X200 blender box"), which does not exist until the turn runs — so a
  // standalone probe on the case's caption would measure a query the product
  // never issues and report a recall number that means nothing. The turn's own
  // retrieval still happens inside respond(); what is lost is only the
  // separately-attributable probe, and recallHit stays null rather than
  // guessing.
  if (!hasKnowledgeBase) {
    record.retrievalProbed = false;
  } else if (media.length === 0) {
    const retrievalStart = Date.now();
    try {
      // EVAL_PROBE_RERANK=false: the probe ranks without the reranker, so a
      // rate-limited rerank key (Cohere trial: 10/min, 1,000/month) is spent
      // only on the agent's own turn. recall@5 is then measured on the fused
      // top-5 rather than the reranked one; the turn itself is unchanged.
      const result = await search.search(
        tenantId,
        turn.question,
        rerank && probeRerankEnabled(),
      );
      record.retrievalMs = Date.now() - retrievalStart;
      // P0.3: the same wall clock, attributed by phase. `retrievalMs` above stays
      // the number the <400ms bar is scored against; this explains it.
      record.retrievalPhases = result.timings;
      record.retrievedChunkIds = result.chunks.map((chunk) => chunk.id);
      record.retrievedScores = result.chunks.map((chunk) => chunk.score);

      // recall@5 proxy: did any retrieved chunk actually carry the expected
      // answer tokens? Cheap and honest — no hand-labelled gold chunk needed.
      if (turn.mustContain?.length) {
        const haystack = result.chunks
          .map((chunk) => chunk.content.toLowerCase())
          .join(' ');
        record.recallHit = turn.mustContain.every((needle) =>
          containsAnyOf(haystack, needle),
        );
      }
    } catch {
      // KBNotIndexed is a legitimate outcome for out-of-scope corpora.
      record.retrievalMs = Date.now() - retrievalStart;
      record.recallHit = turn.mustContain?.length ? false : null;
    }
  }

  // --- generation pass ---
  try {
    // L2: identity resolved by the caller and passed through exactly as the
    // real respond path does (RespondPathProcessor.process()) — never
    // bypassed — so `create_order`'s idempotency key and `track_order`'s
    // customer scoping run against the REAL ToolExecutionContext, not an
    // eval-only shortcut.
    const turnResult = await agent.respond({
      tenantId,
      conversationId,
      customerId,
      turnId,
      conversationSummary: summary,
      recentMessages: history,
      // F17: a voice-only turn carries no text, exactly as the respond path
      // sees it (`currentMessage` is the join of the inbound messages' text).
      // `question` stays the scorecard's label for such a case.
      currentMessage: turn.messageText ?? turn.question,
      tenantPolicy: {
        tonePersonaOverride: EVAL_PERSONA,
        forbiddenTopics: [],
        confidenceThreshold: threshold,
        rerankEnabled: rerank,
      },
      // F17: empty on a text case, which is every pre-Feature-17 case.
      media,
    });

    record.answer = turnResult.answer;
    record.escalated = turnResult.escalate;
    record.escalationReason = turnResult.escalationReason ?? null;
    record.escalationSource = turnResult.escalationSource ?? null;
    record.escalationDetail = turnResult.escalationDetail ?? null;
    record.confidence = turnResult.confidence;
    record.citedChunkIds = turnResult.citedChunkIds;
    record.isHallucination = turnResult.isHallucination;
    record.promptVersion = turnResult.promptVersion;
    record.latencyMs = turnResult.telemetry.latencyMs;
    record.inputTokens = turnResult.telemetry.inputTokens;
    record.outputTokens = turnResult.telemetry.outputTokens;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  }

  return record;
}

async function writeResults(input: {
  runRecords: TurnRecord[][];
  threshold: number;
  rerank: boolean;
  pinned: boolean;
}): Promise<void> {
  const { runRecords, threshold, rerank, pinned } = input;
  const runs = runRecords.length;
  // Pooled records drive the sections where more samples are strictly better
  // (threshold sweep, calibration means, escalation mix). Per-run metrics drive
  // the spread and the verdict; the two must not be confused.
  const records = runRecords.flat();

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(RESULTS_DIR, stamp);
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, 'turns.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );

  const perRunMetrics = runRecords.map((runRecord) =>
    computeMetrics(runRecord),
  );
  const stability = classifyCases(runRecords);
  const metrics = computeMetrics(records);
  const sweep = sweepThresholds(
    records,
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  );

  // Cases where the judge and the deterministic checks disagree: surfaced,
  // never silently scored either way.
  const needsReview = records.filter(
    (record) =>
      (record.deterministicPass && record.judgeVerdict === 'incorrect') ||
      (!record.deterministicPass &&
        record.judgeVerdict === 'correct' &&
        !record.deterministicFailures.some(
          (failure) =>
            failure.startsWith('LEAKED') ||
            failure.startsWith('VIOLATED') ||
            failure.startsWith('HALLUCINATION'),
        )),
  );
  await writeFile(
    join(dir, 'needs-review.json'),
    JSON.stringify(needsReview, null, 2),
  );

  const note = determinismNote(pinned);
  const scorecard = renderScorecard({
    records,
    metrics,
    sweep,
    threshold,
    rerank,
    rerankProvider: process.env.RERANK_PROVIDER ?? 'none',
    needsReviewCount: needsReview.length,
    determinismNote: note,
    multiRun: { perRunMetrics, stability },
  });
  await writeFile(join(dir, 'scorecard.md'), scorecard);

  // Machine-readable twin of the scorecard, so two dated invocations can be
  // diffed by a script instead of by eye — the point of P0.1 is that "did this
  // change help?" stops being a judgement call.
  const summary = summariseStability(stability);
  await writeFile(
    join(dir, 'runs.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runs,
        cases: stability.length,
        config: {
          threshold,
          rerank,
          rerankProvider: process.env.RERANK_PROVIDER ?? 'none',
          ...resolveLlmConfig(process.env),
          embeddingModel: process.env.EMBEDDING_MODEL ?? 'unknown',
          temperaturePinned: pinned,
          temperature: pinned ? EVAL_TEMPERATURE : null,
          determinismNote: note,
          promptVersion: records[0]?.promptVersion ?? null,
        },
        perRun: perRunMetrics.map((runMetrics, index) => ({
          run: index + 1,
          metrics: runMetrics,
          failingCases: runRecords[index].filter(
            (record) => !record.deterministicPass,
          ).length,
        })),
        aggregate: aggregateMetrics(perRunMetrics),
        stability: {
          stablePass: summary.stablePass,
          stableFail: summary.stableFail,
          flaky: summary.flaky,
        },
      },
      null,
      2,
    ),
  );

  console.log(`\n${scorecard}`);
  console.log(`\nartifacts: eval/results/${stamp}/`);
}

main()
  .then(() => {
    // The NestJS app context this file never closes leaves open handles
    // (Redis/BullMQ connections — e.g. the shipment-poll repeat job) that
    // keep the event loop alive indefinitely on a clean run. Every failure
    // path already exits via the .catch() below; this is the success path's
    // equivalent, not a behavior change to what gets scored or written.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(
      `eval failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });
