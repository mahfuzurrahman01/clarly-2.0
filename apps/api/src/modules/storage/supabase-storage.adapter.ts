// Platform (StorageModule): the production ObjectStorage
// binding — Supabase Storage, per docs/decisions/tool-stack.md. This
// is the swap F2.5-kb-foundation.md flagged as "deferred, not blocked";
// nothing about the port changed to accommodate it.
//
// storageKey is `${tenantId}/${randomUUID()}`, byte-identical to
// LocalFilesystemStorageAdapter's scheme — deliberately NEVER derived from
// the caller-supplied filename, so a crafted filename can't escape the
// tenant prefix. Keeping both adapters on one scheme means a tenant's rows
// in kb_documents stay valid across a local -> supabase cutover: the same
// storageKey resolves under either backing (given a data migration of the
// bytes themselves).
//
// Selected at runtime when AppConfigService.kbStorageProvider ===
// 'supabase' (see storage.module.ts's factory) — but, like
// SupabaseAdminProvisioningAdapter, this class is ALWAYS constructed by
// Nest regardless of which binding the factory picks, so the Supabase
// client is built lazily on first real use: `createClient()` can throw on
// an empty/invalid URL, and supabaseUrl/supabaseServiceRoleKey are
// legitimately empty strings under the default 'local' provider.
//
// The service-role key is used rather than an anon key because these are
// private, tenant-owned documents: no end user ever reads this bucket
// directly, and there is no Storage RLS policy to satisfy — isolation is
// enforced by this API, which only ever hands a caller the storageKey its
// own tenant-scoped kb_documents row already contains.
import { Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { AppConfigService } from '../core';
import { ObjectStorage, type StoredObject } from './ports/object-storage.port';

@Injectable()
export class SupabaseStorageAdapter extends ObjectStorage {
  private client: SupabaseClient | undefined;

  constructor(private readonly config: AppConfigService) {
    super();
  }

  private bucket() {
    this.client ??= createClient(
      this.config.supabaseUrl,
      this.config.supabaseServiceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    return this.client.storage.from(this.config.kbStorageBucket);
  }

  async upload(
    tenantId: string,
    _filename: string,
    content: Buffer,
  ): Promise<StoredObject> {
    const storageKey = `${tenantId}/${randomUUID()}`;
    // upsert: false — storageKey is a fresh UUID every call, so an existing
    // object at that key means something is badly wrong (UUID collision, or
    // a caller reusing keys). Failing loudly beats silently overwriting
    // another document's bytes.
    const { error } = await this.bucket().upload(storageKey, content, {
      upsert: false,
      contentType: 'application/octet-stream',
    });
    if (error) {
      throw new Error(
        `SupabaseStorageAdapter: failed to upload ${storageKey}: ${error.message}`,
      );
    }
    return { storageKey, sizeBytes: content.byteLength };
  }

  async download(storageKey: string): Promise<Buffer> {
    const { data, error } = await this.bucket().download(storageKey);
    if (error || !data) {
      throw new Error(
        `SupabaseStorageAdapter: failed to download ${storageKey}: ${error?.message ?? 'no data returned'}`,
      );
    }
    return Buffer.from(await data.arrayBuffer());
  }

  /**
   * Deleting an already-absent key is a no-op, matching
   * LocalFilesystemStorageAdapter's `rm(..., { force: true })` — T16's purge
   * path re-runs on retry, and a second delete must not fail the job.
   * Supabase's `remove()` already returns success for missing keys rather
   * than erroring, so only a genuine transport/permission failure throws.
   */
  async delete(storageKey: string): Promise<void> {
    const { error } = await this.bucket().remove([storageKey]);
    if (error) {
      throw new Error(
        `SupabaseStorageAdapter: failed to delete ${storageKey}: ${error.message}`,
      );
    }
  }
}
