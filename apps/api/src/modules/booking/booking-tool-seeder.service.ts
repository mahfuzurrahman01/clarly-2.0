// Clarly 2.0 S2: keeps the two booking tools' tenant_tools rows in step with
// the booking mode. Same posture as OrderToolSeederService: DISABLED, not
// deleted, when bookings are off; and the executors re-check the mode, so a
// stale enabled row cannot book anything (the execution gate).
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import type { BookingMode } from '../persistence/drizzle/schema';
import { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import { BOOKING_TOOL_DEFINITIONS } from './booking-tools';

@Injectable()
export class BookingToolSeederService {
  constructor(
    private readonly toolRegistry: TenantToolRegistryService,
    private readonly logger: AppLoggerService,
  ) {}

  async syncForMode(tenantId: string, mode: BookingMode): Promise<void> {
    for (const tool of BOOKING_TOOL_DEFINITIONS) {
      await this.toolRegistry.upsertTool(tenantId, {
        name: tool.name,
        description: tool.description,
        jsonSchema: tool.jsonSchema,
        enabled: mode !== 'disabled',
      });
    }
  }

  /** The mode change is already committed; a failed row write leaves the tenant more restricted, never less. */
  async syncForModeBestEffort(
    tenantId: string,
    mode: BookingMode,
  ): Promise<void> {
    try {
      await this.syncForMode(tenantId, mode);
    } catch (error) {
      this.logger.error(
        `syncing booking tool rows for tenant ${tenantId} (mode ${mode}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        'BookingToolSeederService',
      );
    }
  }
}
