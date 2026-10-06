// Platform (CoreModule). Launch Plan item 7 root-cause fix: StuckTicketCheckService,
// LatencyBudgetCheckService and AutoCloseSweepService (and, found during the same
// read, ToolScopeViolationCheckService — not fixed here, same bug, out of this
// pass's named scope) each swept every tenant with a bare, unbounded
// `Promise.all(tenantRows.map(tenant => this.checkTenant(tenant.id)))`.
//
// Two compounding problems with that, against a Postgres pool capped at `max: 10`
// (persistence.providers.ts) shared with live HTTP/respond-path traffic and every
// other periodic sweep in this same process:
//
//  1. Unbounded fan-out. With N tenants, N `withTenantTx()` calls fire
//     concurrently, each trying to acquire one of only 10 pool connections. Past
//     ~10 tenants (fewer once the pool has other live borrowers), later calls queue
//     for a connection; `connectionTimeoutMillis: 10_000` means a caller that waits
//     longer than 10s gets a rejected promise, not a slow success.
//  2. Promise.all's fail-fast semantics. A single tenant's connection-acquisition
//     timeout — or ANY other per-tenant error — rejects the WHOLE batch, failing
//     the sweep for every other tenant too. Every one of these processors'
//     comments claims "a failed sweep just means this cycle's alerts are late, the
//     next scheduled run re-scans" (see stuck-ticket-check.processor.ts) — a
//     promise the Promise.all fan-out did not actually keep: one poisoned tenant
//     took the healthy 99 down with it.
//
// This is what actually landed jobs in the BullMQ failed set (T11's own DLQ
// definition) climbing toward QUEUE_DLQ_DEPTH_THRESHOLD as tenant count grew —
// not a logic bug in any one tenant's check, a concurrency/isolation bug in how
// the batch runs.
//
// The fix: bounded concurrency (keep well under the pool's headroom) PLUS
// per-tenant error isolation (one tenant's failure is logged and skipped, never
// propagated to the batch) — restoring the "late, not lost" guarantee the
// processors' comments already promise.
import type { AppLoggerService } from '../logger/app-logger.service';

/** Conservative relative to the pool's `max: 10` — these sweeps share the pool with live HTTP/respond-path traffic and every other periodic job, so this must leave real headroom, not approach the ceiling. */
export const DEFAULT_TENANT_SWEEP_CONCURRENCY = 3;

export interface TenantSweepResult<T> {
  tenantId: string;
  value: T;
}

/**
 * Runs `fn` for every tenant id with at most `concurrency` in flight at once,
 * and never lets one tenant's rejection take down the batch: a failure is
 * logged and that tenant is skipped, exactly like the callers' own doc
 * comments already promise ("late, not lost — the next scheduled run
 * re-scans"). Returns only the successful results, in no particular order.
 */
export async function sweepTenantsWithBoundedConcurrency<T>(
  tenantIds: readonly string[],
  fn: (tenantId: string) => Promise<T>,
  options: {
    concurrency?: number;
    logger: AppLoggerService;
    /** For the log line — which sweep this is, e.g. "stuck-ticket-check". */
    sweepName: string;
  },
): Promise<TenantSweepResult<T>[]> {
  const concurrency = Math.max(
    1,
    options.concurrency ?? DEFAULT_TENANT_SWEEP_CONCURRENCY,
  );
  const results: TenantSweepResult<T>[] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= tenantIds.length) return;
      const tenantId = tenantIds[index];
      try {
        const value = await fn(tenantId);
        results.push({ tenantId, value });
      } catch (error) {
        // Never rethrown: one tenant's failure (a connection-acquisition
        // timeout under pool pressure, a transient query error, ...) must
        // not cost every other tenant this cycle's alert. The next
        // scheduled run re-scans this tenant.
        options.logger.warn(
          `${options.sweepName} sweep failed for tenant ${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          } — skipped this cycle, next run will retry`,
          options.sweepName,
        );
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tenantIds.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
