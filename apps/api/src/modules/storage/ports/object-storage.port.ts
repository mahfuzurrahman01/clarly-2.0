// Agent (AI-owned, KnowledgeBaseModule): storage abstraction behind KB
// document upload. Unlike T0's BspAdapter, Supabase Storage isn't a
// *pending* decision — the tech-stack table (docs/decisions/tool-stack.md) already
// finalized it — so this isn't "don't write a concrete adapter yet," it's
// "no Supabase project is provisioned in this environment" (same
// constraint Feature 0 hit with Postgres/Redis, solved the same way: a
// real, working local backing for dev/CI, with the cloud adapter's env
// vars and setup documented as a TODO rather than blocking).
export interface StoredObject {
  storageKey: string;
  sizeBytes: number;
}

/**
 * Abstract class so it doubles as its own NestJS DI token, same convention
 * as LlmProvider/VectorStore/BspAdapter. `LocalFilesystemStorageAdapter`
 * (this pass) is the real dev/CI binding; a `SupabaseStorageAdapter`
 * implementing the same three methods is the prod swap once a Supabase
 * project exists — see docs/decisions/F2.5-kb-foundation.md.
 */
export abstract class ObjectStorage {
  abstract upload(
    tenantId: string,
    filename: string,
    content: Buffer,
  ): Promise<StoredObject>;
  abstract download(storageKey: string): Promise<Buffer>;
  abstract delete(storageKey: string): Promise<void>;
}
