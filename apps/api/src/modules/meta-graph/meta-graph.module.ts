// Channel (Gulf T1, D8): the shared Meta Graph API client.
//
// Before T1 the Graph client lived inside MetaChannelModule (Messenger +
// Instagram) while MetaCloudAdapter (WhatsApp) made its own raw `fetch`
// calls — two places for the base URL, version, timeout, bearer auth and
// Meta's error envelope. This module is now the one place, imported by both
// WhatsappModule and MetaChannelModule.
//
// Module-boundary note: depends ONLY on CoreModule (config + logger). It
// must never import a channel module — both channel modules import it, so
// any edge back would be a DI cycle.
import { Module, type OnModuleInit } from '@nestjs/common';
import { AppConfigService, AppLoggerService, CoreModule } from '../core';
import { MetaGraphClient } from './meta-graph.client';

export * from './meta-graph.client';
export * from './meta-graph.error';
export { hashMetaUserId } from './meta-user-id-hash';

@Module({
  imports: [CoreModule],
  providers: [MetaGraphClient],
  exports: [MetaGraphClient],
})
export class MetaGraphModule implements OnModuleInit {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /** D8: `META_SOCIAL_*` are deprecated aliases for one release — say so once, at startup, never with the values. */
  onModuleInit(): void {
    for (const warning of this.config.deprecatedMetaEnvWarnings) {
      this.logger.warn(warning, MetaGraphModule.name);
    }
  }
}
