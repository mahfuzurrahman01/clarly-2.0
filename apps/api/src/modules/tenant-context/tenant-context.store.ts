// Platform (TenantContextModule): AsyncLocalStorage-backed tenant context.
// Full population from a Supabase Auth JWT claim / webhook tenant resolution
// is Feature 1/2 work (T5/T6/T7). Feature 0 ships the storage primitive and
// withTenantTx() so Feature 1+ only has to call `run()` at the request
// boundary (auth guard, webhook handler) — no new plumbing.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContextStore {
  tenantId: string;
}

export const tenantContextStorage = new AsyncLocalStorage<TenantContextStore>();
