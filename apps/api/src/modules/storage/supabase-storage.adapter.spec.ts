import type { AppConfigService } from '../core';
import { SupabaseStorageAdapter } from './supabase-storage.adapter';

const bucketApi = {
  upload: jest.fn(),
  download: jest.fn(),
  remove: jest.fn(),
};
const from = jest.fn(() => bucketApi);
const createClient = jest.fn(() => ({ storage: { from } }));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => createClient(),
}));

function makeConfig(
  overrides: Partial<AppConfigService> = {},
): AppConfigService {
  return {
    supabaseUrl: 'http://127.0.0.1:54321',
    supabaseServiceRoleKey: 'service-role-key',
    kbStorageBucket: 'kb-documents',
    ...overrides,
  } as AppConfigService;
}

describe('SupabaseStorageAdapter', () => {
  let adapter: SupabaseStorageAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    bucketApi.upload.mockResolvedValue({ error: null });
    bucketApi.remove.mockResolvedValue({ error: null });
    adapter = new SupabaseStorageAdapter(makeConfig());
  });

  it('does not build a Supabase client until a method is actually called', () => {
    // The factory in knowledge-base.module.ts constructs BOTH adapters
    // regardless of which one it binds, so an eagerly-created client would
    // throw at startup under KB_STORAGE_PROVIDER=local (empty URL).
    new SupabaseStorageAdapter(
      makeConfig({ supabaseUrl: '', supabaseServiceRoleKey: '' }),
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it('reuses one client across calls', async () => {
    bucketApi.download.mockResolvedValue({
      data: new Blob([Buffer.from('a')]),
      error: null,
    });

    await adapter.upload('tenant-a', 'f.txt', Buffer.from('a'));
    await adapter.download('tenant-a/key');

    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('namespaces the storage key under the tenant id and never derives it from the filename', async () => {
    const stored = await adapter.upload(
      'tenant-a',
      '../../../etc/passwd',
      Buffer.from('not actually etc/passwd'),
    );

    expect(stored.storageKey).toMatch(/^tenant-a\/[0-9a-f-]{36}$/);
    expect(bucketApi.upload).toHaveBeenCalledWith(
      stored.storageKey,
      expect.any(Buffer),
      expect.objectContaining({ upsert: false }),
    );
  });

  it('reports the uploaded byte length', async () => {
    const content = Buffer.from('hello world');
    const stored = await adapter.upload('tenant-a', 'f.txt', content);
    expect(stored.sizeBytes).toBe(content.byteLength);
  });

  it('uploads into the configured bucket', async () => {
    await adapter.upload('tenant-a', 'f.txt', Buffer.from('a'));
    expect(from).toHaveBeenCalledWith('kb-documents');
  });

  it('throws with the storage key and vendor message when upload fails', async () => {
    bucketApi.upload.mockResolvedValue({
      error: { message: 'bucket missing' },
    });

    await expect(
      adapter.upload('tenant-a', 'f.txt', Buffer.from('a')),
    ).rejects.toThrow(/tenant-a\/.*bucket missing/);
  });

  it('round-trips downloaded content as a Buffer', async () => {
    bucketApi.download.mockResolvedValue({
      data: new Blob([Buffer.from('hello world')]),
      error: null,
    });

    const downloaded = await adapter.download('tenant-a/key');

    expect(downloaded).toBeInstanceOf(Buffer);
    expect(downloaded.toString('utf8')).toBe('hello world');
  });

  it('throws when download returns no data even without an error', async () => {
    bucketApi.download.mockResolvedValue({ data: null, error: null });

    await expect(adapter.download('tenant-a/key')).rejects.toThrow(
      /no data returned/,
    );
  });

  it('delete() is a no-op-safe passthrough to remove()', async () => {
    await expect(adapter.delete('tenant-a/key')).resolves.toBeUndefined();
    expect(bucketApi.remove).toHaveBeenCalledWith(['tenant-a/key']);
  });

  it('throws when delete fails for a real transport reason', async () => {
    bucketApi.remove.mockResolvedValue({ error: { message: 'forbidden' } });

    await expect(adapter.delete('tenant-a/key')).rejects.toThrow(/forbidden/);
  });
});
