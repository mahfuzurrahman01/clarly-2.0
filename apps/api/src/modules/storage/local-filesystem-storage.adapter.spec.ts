import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfigService } from '../core';
import { LocalFilesystemStorageAdapter } from './local-filesystem-storage.adapter';

function makeConfig(dir: string): AppConfigService {
  return { kbLocalStorageDir: dir } as AppConfigService;
}

describe('LocalFilesystemStorageAdapter', () => {
  let baseDir: string;
  let adapter: LocalFilesystemStorageAdapter;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `kb-storage-test-${randomUUID()}`);
    adapter = new LocalFilesystemStorageAdapter(makeConfig(baseDir));
    await adapter.onModuleInit();
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('round-trips uploaded content', async () => {
    const content = Buffer.from('hello world');
    const stored = await adapter.upload('tenant-a', 'notes.txt', content);

    const downloaded = await adapter.download(stored.storageKey);

    expect(downloaded.toString('utf8')).toBe('hello world');
    expect(stored.sizeBytes).toBe(content.byteLength);
  });

  it('namespaces the storage key under the tenant id', async () => {
    const stored = await adapter.upload(
      'tenant-a',
      'file.txt',
      Buffer.from('x'),
    );
    expect(stored.storageKey.startsWith('tenant-a/')).toBe(true);
  });

  it('never derives the storage path from the caller-supplied filename (no path traversal surface)', async () => {
    const stored = await adapter.upload(
      'tenant-a',
      '../../../etc/passwd',
      Buffer.from('not actually etc/passwd'),
    );

    // The storage key is tenant-a/<uuid>, never anything derived from the
    // malicious filename — download() only ever resolves paths under
    // baseDir/tenant-a, regardless of what filename was supplied at upload.
    expect(stored.storageKey).toMatch(/^tenant-a\/[0-9a-f-]{36}$/);
    await expect(adapter.download(stored.storageKey)).resolves.toEqual(
      Buffer.from('not actually etc/passwd'),
    );
  });

  it('delete() removes the file; a second delete() is a harmless no-op', async () => {
    const stored = await adapter.upload(
      'tenant-a',
      'file.txt',
      Buffer.from('x'),
    );

    await adapter.delete(stored.storageKey);
    await expect(adapter.delete(stored.storageKey)).resolves.toBeUndefined();
    await expect(adapter.download(stored.storageKey)).rejects.toThrow();
  });
});
