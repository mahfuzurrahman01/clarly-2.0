// Platform (StorageModule): the dev/CI ObjectStorage binding.
// storageKey is `${tenantId}/${randomUUID()}` — deliberately NEVER derived
// from the caller-supplied filename, so there is no path-traversal surface
// from a crafted filename (e.g. "../../etc/passwd"); the original filename
// is stored only as metadata (kb_documents.filename), never used to build
// a filesystem path.
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AppConfigService } from '../core';
import { ObjectStorage, type StoredObject } from './ports/object-storage.port';

@Injectable()
export class LocalFilesystemStorageAdapter
  extends ObjectStorage
  implements OnModuleInit
{
  private readonly baseDir: string;

  constructor(config: AppConfigService) {
    super();
    this.baseDir = isAbsolute(config.kbLocalStorageDir)
      ? config.kbLocalStorageDir
      : join(process.cwd(), config.kbLocalStorageDir);
  }

  async onModuleInit(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  async upload(
    tenantId: string,
    _filename: string,
    content: Buffer,
  ): Promise<StoredObject> {
    const storageKey = `${tenantId}/${randomUUID()}`;
    const filePath = this.resolvePath(storageKey);
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, content);
    return { storageKey, sizeBytes: content.byteLength };
  }

  async download(storageKey: string): Promise<Buffer> {
    return readFile(this.resolvePath(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.resolvePath(storageKey), { force: true });
  }

  /** storageKey is always the value THIS adapter generated (tenantId/uuid, both DB-controlled at write time), never re-derived from untrusted input at read time. */
  private resolvePath(storageKey: string): string {
    return join(this.baseDir, storageKey);
  }
}
