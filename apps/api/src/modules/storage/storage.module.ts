import { Module } from '@nestjs/common';
import { AppConfigService, CoreModule } from '../core';
import { LocalFilesystemStorageAdapter } from './local-filesystem-storage.adapter';
import { ObjectStorage } from './ports/object-storage.port';
import { SupabaseStorageAdapter } from './supabase-storage.adapter';

export * from './ports/object-storage.port';
export { LocalFilesystemStorageAdapter } from './local-filesystem-storage.adapter';
export { SupabaseStorageAdapter } from './supabase-storage.adapter';

// Platform: object storage, and the runtime choice of backing.
//
// Extracted from KnowledgeBaseModule (F13) once a second and third consumer
// appeared: inbound WhatsApp media has to be stored and served, and that has
// nothing to do with the knowledge base. Leaving the port inside an AI-owned
// module would have meant the channel and inbox layers importing
// KnowledgeBaseModule to reach a filesystem adapter — a dependency that says
// something untrue about what those layers need.
//
// Nothing about the port or either adapter changed in the move; the env vars
// keep their `KB_` names deliberately, because renaming them would break
// every deployed environment for a refactor nobody asked for.
@Module({
  imports: [CoreModule],
  providers: [
    LocalFilesystemStorageAdapter,
    SupabaseStorageAdapter,
    {
      // Both adapters are constructed, one is bound.
      // SupabaseStorageAdapter builds its client lazily precisely so
      // constructing it under KB_STORAGE_PROVIDER=local is harmless.
      provide: ObjectStorage,
      useFactory: (
        config: AppConfigService,
        supabase: SupabaseStorageAdapter,
        local: LocalFilesystemStorageAdapter,
      ) => (config.kbStorageProvider === 'supabase' ? supabase : local),
      inject: [
        AppConfigService,
        SupabaseStorageAdapter,
        LocalFilesystemStorageAdapter,
      ],
    },
  ],
  exports: [ObjectStorage],
})
export class StorageModule {}
