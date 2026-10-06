/**
 * Re-embeds every kb_chunks row whose vector no longer matches the bound
 * embedder, and is the mandatory second half of migration 0023.
 *
 * D5's whole point is that an embedding model swap is a background re-embed
 * rather than a schema rebuild, because every chunk carries its own
 * `embedding_version`. This script is what makes that true in practice.
 *
 * Migration 0023 retyped kb_chunks.embedding to halfvec(2560) and stamped
 * every existing row `embedding_version = 'pending-reembed'` with a zero
 * placeholder vector. Those rows are effectively invisible to retrieval (a
 * zero vector gives NaN cosine distance, which Postgres sorts last) until
 * this runs. Until then the KB answers nothing.
 *
 * It boots a real Nest application context rather than talking to Postgres
 * directly, so the vectors it writes come from the same `Embedder` binding
 * the ingest path uses — reimplementing the embedding call here would be a
 * second source of truth for which model/version stamps a chunk. Writes go
 * through withTenantTx() so RLS applies exactly as it does in the app; the
 * only admin-scoped query is the initial "which tenants have work?" scan,
 * which by definition spans tenants.
 *
 * Usage:
 *   npm run db:reembed --workspace=api                # only pending rows
 *   npm run db:reembed --workspace=api -- --all       # every row, any version
 *   npm run db:reembed --workspace=api -- --tenant <uuid>
 *   npm run db:reembed --workspace=api -- --dry-run
 *
 * Safe to re-run: each row is matched by id and rewritten idempotently, so
 * an interrupted run resumes simply by being run again (already-done rows
 * no longer carry the pending sentinel and drop out of the selection).
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/modules/core';
import {
  Embedder,
  type EmbeddingVector,
} from '../src/modules/llm/ports/embedder.port';
import { QwenEmbedder } from '../src/modules/llm/qwen-embedder.adapter';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';

/** The sentinel migration 0023 stamps on rows it invalidated. */
const PENDING_VERSION = 'pending-reembed';

/**
 * Rows per embedding call. The vLLM endpoint embeds an array in one forward
 * pass — 32 inputs measured at ~1.9s versus ~13s for 32 sequential calls —
 * and the batch is also one UPDATE round-trip. Kept modest so a single
 * failure costs little work and so a large batch cannot exceed the server's
 * queue limits.
 */
const BATCH_SIZE = 32;

interface PendingRow extends Record<string, unknown> {
  id: string;
  content: string;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  return {
    all: argv.includes('--all'),
    dryRun: argv.includes('--dry-run'),
    tenantId: flag('tenant'),
  };
}

async function main(): Promise<void> {
  const { all, dryRun, tenantId } = parseArgs();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });

  const config = app.get(AppConfigService);
  const persistence = app.get(PersistenceService);
  const tenantContext = app.get(TenantContextService);
  const embedder = app.get(Embedder);

  console.log(
    `reembed: provider=${config.embeddingProvider} model=${config.embeddingModel} ` +
      `dims=${config.embeddingDimensions} scope=${all ? 'ALL rows' : `version='${PENDING_VERSION}'`}` +
      `${tenantId ? ` tenant=${tenantId}` : ''}${dryRun ? ' [DRY RUN]' : ''}`,
  );

  // kb_chunks has FORCE ROW LEVEL SECURITY and runAdminQuery() does NOT
  // bypass it — it is an escape hatch for genuinely untenanted tables, not a
  // superuser mode, so a cross-tenant `SELECT ... FROM kb_chunks` there
  // returns zero rows rather than erroring. The tenant list therefore comes
  // from `tenants` (no RLS, the sanctioned admin-scoped read) and every
  // kb_chunks access happens inside withTenantTx().
  const tenantRows = await persistence.runAdminQuery((db) =>
    db.execute<{ id: string }>(sql`
      SELECT id::text AS id
      FROM tenants
      ${tenantId ? sql`WHERE id = ${tenantId}::uuid` : sql``}
      ORDER BY id
    `),
  );

  const scope = all ? sql`true` : sql`embedding_version = ${PENDING_VERSION}`;

  // Counted per tenant under that tenant's own GUC, for the same reason.
  const tenants: Array<{ tenantId: string; pending: number }> = [];
  for (const { id } of tenantRows.rows) {
    const counted = await tenantContext.withTenantTx(async (tx) => {
      const result = await tx.execute<{ pending: string }>(sql`
        SELECT count(*)::text AS pending FROM kb_chunks WHERE ${scope}
      `);
      return Number(result.rows[0]?.pending ?? 0);
    }, id);
    if (counted > 0) tenants.push({ tenantId: id, pending: counted });
  }

  if (tenants.length === 0) {
    console.log('reembed: nothing to do — no matching chunks.');
    await app.close();
    return;
  }

  const totalPending = tenants.reduce((sum, row) => sum + row.pending, 0);
  console.log(
    `reembed: ${totalPending} chunk(s) across ${tenants.length} tenant(s)\n`,
  );

  if (dryRun) {
    for (const row of tenants) {
      console.log(`  ${row.tenantId}  ${row.pending} chunk(s)`);
    }
    console.log('\nreembed: dry run, nothing written.');
    await app.close();
    return;
  }

  let done = 0;
  let failed = 0;

  for (const { tenantId: tenant } of tenants) {
    // Re-selected inside the loop rather than held from the scan above so
    // each tenant's read happens under its own RLS-scoped transaction.
    const pending = await tenantContext.withTenantTx(async (tx) => {
      const result = await tx.execute<PendingRow>(sql`
        SELECT id::text AS id, content
        FROM kb_chunks
        WHERE ${scope}
        ORDER BY id
      `);
      return result.rows;
    }, tenant);

    for (let offset = 0; offset < pending.length; offset += BATCH_SIZE) {
      const batch = pending.slice(offset, offset + BATCH_SIZE);

      let vectors: EmbeddingVector[];
      try {
        vectors = await embedBatch(
          embedder,
          batch.map((row) => row.content),
        );
      } catch (error) {
        // One bad batch must not abandon the remaining tenants — the run is
        // resumable, so the useful behaviour is to keep going and report a
        // non-zero exit at the end.
        failed += batch.length;
        console.error(
          `  ${tenant}: batch at offset ${offset} failed — ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      await tenantContext.withTenantTx(async (tx) => {
        for (const [index, row] of batch.entries()) {
          const vector = vectors[index];
          if (!vector) continue;
          await tx.execute(sql`
            UPDATE kb_chunks
            SET embedding = ${`[${vector.values.join(',')}]`}::vector,
                embedding_model = ${vector.embeddingModel},
                embedding_version = ${vector.embeddingVersion}
            WHERE id = ${row.id}::uuid
          `);
        }
      }, tenant);

      done += batch.length;
      process.stdout.write(`\r  progress: ${done}/${totalPending}`);
    }
  }

  process.stdout.write('\n');

  // Independent verification rather than trusting the counters above: the
  // question that actually matters is whether any chunk is still
  // unretrievable, and that is a property of the table, not of this loop.
  // Per-tenant for the RLS reason described at the top — an admin-scoped
  // count here would read zero no matter what and always claim success.
  let stillPending = 0;
  for (const { tenantId: tenant } of tenants) {
    stillPending += await tenantContext.withTenantTx(async (tx) => {
      const result = await tx.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM kb_chunks
        WHERE embedding_version = ${PENDING_VERSION}
      `);
      return Number(result.rows[0]?.count ?? 0);
    }, tenant);
  }

  console.log(
    `\nreembed: ${done} re-embedded, ${failed} failed, ${stillPending} still pending.`,
  );

  await app.close();

  if (failed > 0 || stillPending > 0) {
    console.error(
      'reembed: INCOMPLETE — those chunks are unretrievable until this is re-run.',
    );
    process.exitCode = 1;
  }
}

/**
 * Uses the batch path when the bound adapter has one, falling back to
 * sequential single embeds otherwise. The `Embedder` port is deliberately
 * single-item (that is all the ingest path needs), so batching is an adapter
 * capability rather than part of the contract — this is the one caller that
 * cares enough to check.
 */
async function embedBatch(
  embedder: Embedder,
  texts: string[],
): Promise<EmbeddingVector[]> {
  if (embedder instanceof QwenEmbedder) {
    return embedder.embedBatch(texts);
  }
  const results: EmbeddingVector[] = [];
  for (const text of texts) {
    results.push(await embedder.embed(text));
  }
  return results;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
