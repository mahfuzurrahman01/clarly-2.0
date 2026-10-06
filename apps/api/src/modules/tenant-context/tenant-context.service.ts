// Platform (TenantContextModule): withTenantTx() — the one sanctioned way
// for the rest of the app to touch the database. Every tenant-scoped query
// must go through here so the RLS GUC (`app.tenant_id`) is always set before
// a single row is read/written inside the transaction; T5's RLS policies
// (Feature 1) depend on this GUC being present, and `current_setting(...,
// true)` returning NULL when it's missing is what makes RLS fail *closed*.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE_DB,
  type DrizzleDb,
} from '../persistence/persistence.providers';
import {
  tenantContextStorage,
  type TenantContextStore,
} from './tenant-context.store';

/** Thrown when withTenantTx() is called with no tenant available — fail closed, never run untenanted queries by accident. */
export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'withTenantTx() called with no tenantId (argument) and no active tenant context (run()). Refusing to open an untenanted transaction.',
    );
    this.name = 'MissingTenantContextError';
  }
}

@Injectable()
export class TenantContextService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  /** Binds `tenantId` to AsyncLocalStorage for the duration of `fn`. Called once at the request boundary (auth guard / webhook handler, Feature 1+). */
  run<T>(tenantId: string, fn: () => Promise<T> | T): Promise<T> | T {
    const store: TenantContextStore = { tenantId };
    return tenantContextStorage.run(store, fn);
  }

  /** Current tenant, if `run()` is on the call stack. */
  getTenantId(): string | undefined {
    return tenantContextStorage.getStore()?.tenantId;
  }

  /**
   * Opens a Postgres transaction, sets `app.tenant_id` via `set_config(...,
   * true)` (transaction-scoped, safe under Supavisor transaction-mode
   * pooling — see docs/decisions/F0-infra.md), runs `fn` inside it, and
   * commits/rolls back. `tenantId` defaults to the active AsyncLocalStorage
   * context; pass it explicitly for call sites that resolve tenant before
   * `run()` is established (e.g. the webhook tenant-resolution step, T6).
   */
  async withTenantTx<T>(
    fn: (tx: DrizzleDb) => Promise<T>,
    tenantId: string | undefined = this.getTenantId(),
  ): Promise<T> {
    if (!tenantId) throw new MissingTenantContextError();

    return this.db.transaction(async (tx) => {
      // set_config's 3rd arg (is_local=true) scopes this exactly like
      // `SET LOCAL` but supports a bound parameter, avoiding string
      // interpolation of the tenant id into SQL.
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn(tx);
    });
  }
}
