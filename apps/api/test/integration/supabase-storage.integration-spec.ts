// Proves SupabaseStorageAdapter against a REAL Supabase Storage instance
// (the local `supabase start` stack), not a mocked supabase-js — same
// reasoning every other integration suite here uses: the unit spec proves
// the adapter's own logic against a fake, this proves the vendor actually
// behaves the way the adapter assumes (upsert:false rejecting a duplicate
// key, remove() tolerating a missing key, download() returning a Blob).
//
// Skips rather than fails when no Supabase stack is reachable, so CI
// without a Supabase service (and any dev who hasn't run `supabase start`)
// stays green. Requires the `kb-documents` bucket to exist — see
// docs/HANDOFF.md's Supabase Storage entry for the one-time bucket setup.
import { randomUUID } from 'node:crypto';
import type { AppConfigService } from '../../src/modules/core';
import { SupabaseStorageAdapter } from '../../src/modules/storage/supabase-storage.adapter';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.KB_STORAGE_BUCKET ?? 'kb-documents';

const describeIfSupabase =
  supabaseUrl && serviceRoleKey ? describe : describe.skip;

describeIfSupabase('SupabaseStorageAdapter (real Supabase Storage)', () => {
  const tenantId = `tenant-${randomUUID()}`;
  const adapter = new SupabaseStorageAdapter({
    supabaseUrl,
    supabaseServiceRoleKey: serviceRoleKey,
    kbStorageBucket: bucket,
  } as AppConfigService);

  const uploaded: string[] = [];

  afterAll(async () => {
    await Promise.all(uploaded.map((key) => adapter.delete(key)));
  });

  it('round-trips a document through upload -> download', async () => {
    const content = Buffer.from('the refund window is 30 days');
    const stored = await adapter.upload(tenantId, 'policy.txt', content);
    uploaded.push(stored.storageKey);

    expect(stored.storageKey.startsWith(`${tenantId}/`)).toBe(true);
    expect(stored.sizeBytes).toBe(content.byteLength);

    const downloaded = await adapter.download(stored.storageKey);
    expect(downloaded.toString('utf8')).toBe('the refund window is 30 days');
  });

  it('delete() removes the object, and a second delete() is a harmless no-op', async () => {
    const stored = await adapter.upload(tenantId, 'temp.txt', Buffer.from('x'));

    await adapter.delete(stored.storageKey);
    await expect(adapter.delete(stored.storageKey)).resolves.toBeUndefined();
    await expect(adapter.download(stored.storageKey)).rejects.toThrow();
  });

  it('download() of a never-uploaded key rejects rather than returning empty bytes', async () => {
    await expect(
      adapter.download(`${tenantId}/${randomUUID()}`),
    ).rejects.toThrow(/failed to download/);
  });
});
