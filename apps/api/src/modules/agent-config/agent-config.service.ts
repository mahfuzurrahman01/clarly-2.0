// Product shell (AgentConfigModule, F9 step 2): resolves the agent that owns
// an inbound turn.
//
// Routing is by WhatsApp number (F9 Decision 4): one number, one agent. The
// tenant is already resolved by the time this runs (T6), so this only has to
// pick the agent within that tenant — and it is tenant-scoped through
// withTenantTx() like every other read, never an admin query.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppLoggerService } from '../core';
import {
  agentKbDocuments,
  agents,
  agentVersions,
  whatsappNumbers,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { BusinessHours } from './business-hours';
import type { IntakeField } from './intake-fields';
import type { ResolvedAgent, ResolvedAgentConfig } from './agent-config.dto';

@Injectable()
export class AgentConfigService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * The published agent answering on this number, or the tenant's single
   * published agent if none is bound to it.
   *
   * The fallback is transitional and deliberate. F9's backfill bound a
   * number only when the tenant had exactly one, because picking between
   * two numbers is a routing decision belonging to the tenant, not to a
   * migration. Without the fallback, every multi-number tenant would stop
   * being attributable the moment this shipped — and once configuration
   * reads move here (F9 step 3), they would stop being answerable at all.
   * It disappears when the console can bind a number to an agent.
   *
   * Returns null rather than throwing when nothing resolves: this slice
   * only decides what a run is LABELLED with, and losing a turn to fix a
   * label would be the wrong trade. When configuration reads move here,
   * unresolvable becomes a hard error, exactly as a missing `tenant_policy`
   * row already is.
   */
  async resolveForPhoneNumber(
    tenantId: string,
    phoneNumberId: string | null,
  ): Promise<ResolvedAgent | null> {
    const published = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            id: agents.id,
            name: agents.name,
            whatsappNumberId: agents.whatsappNumberId,
            configVersion: agentVersions.version,
            persona: agentVersions.persona,
            forbiddenTopics: agentVersions.forbiddenTopics,
            confidenceThreshold: agentVersions.confidenceThreshold,
            rerankEnabled: agentVersions.rerankEnabled,
            handoverAutoReturnMinutes: agentVersions.handoverAutoReturnMinutes,
            maxToolCallsPerTurn: agentVersions.maxToolCallsPerTurn,
            businessHours: agentVersions.businessHours,
            timezone: agentVersions.timezone,
            outOfHoursResponse: agentVersions.outOfHoursResponse,
            intakeFields: agentVersions.intakeFields,
          })
          .from(agents)
          .innerJoin(
            agentVersions,
            eq(agentVersions.id, agents.publishedVersionId),
          )
          .where(
            and(eq(agents.tenantId, tenantId), eq(agents.status, 'published')),
          ),
      tenantId,
    );

    if (published.length === 0) {
      this.logger.warn(
        `no published agent for tenant ${tenantId} — this turn will be recorded without agent attribution`,
        'AgentConfigService',
      );
      return null;
    }

    if (phoneNumberId) {
      const numberRows = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: whatsappNumbers.id })
            .from(whatsappNumbers)
            .where(eq(whatsappNumbers.phoneNumberId, phoneNumberId))
            .limit(1),
        tenantId,
      );

      const boundNumberId = numberRows[0]?.id;
      const bound = boundNumberId
        ? published.find((agent) => agent.whatsappNumberId === boundNumberId)
        : undefined;

      if (bound) {
        return {
          agentId: bound.id,
          name: bound.name,
          configVersion: bound.configVersion,
          resolvedBy: 'number',
          config: toConfig(
            bound,
            await this.scopedDocumentIds(tenantId, bound.id),
          ),
        };
      }
    }

    // More than one published agent and no binding for this number: guessing
    // would attribute a turn to an agent that may not have answered it, and a
    // wrong attribution is worse than none — it is silently wrong in the
    // metrics a tenant uses to judge a change.
    if (published.length > 1) {
      this.logger.warn(
        `tenant ${tenantId} has ${published.length} published agents and none bound to phone number ${phoneNumberId ?? '(none on job)'} — recording this turn without agent attribution`,
        'AgentConfigService',
      );
      return null;
    }

    const [only] = published;
    return {
      agentId: only.id,
      name: only.name,
      configVersion: only.configVersion,
      resolvedBy: 'tenant_fallback',
      config: toConfig(only, await this.scopedDocumentIds(tenantId, only.id)),
    };
  }

  /**
   * The business hours the tenant operates on, for consumers that are
   * tenant-level rather than per-turn (the stuck-ticket sweep).
   *
   * Null when the tenant has no single published agent: with several agents
   * on different hours there is no one answer, and picking one would judge a
   * ticket against hours its own agent never had. Those consumers become
   * agent-aware when tickets carry an agent.
   */
  async getTenantBusinessHours(tenantId: string): Promise<{
    hours: BusinessHours | null;
    timezone: string | null;
  } | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            businessHours: agentVersions.businessHours,
            timezone: agentVersions.timezone,
          })
          .from(agents)
          .innerJoin(
            agentVersions,
            eq(agentVersions.id, agents.publishedVersionId),
          )
          .where(
            and(eq(agents.tenantId, tenantId), eq(agents.status, 'published')),
          ),
      tenantId,
    );

    if (rows.length !== 1) return null;

    return {
      hours: (rows[0].businessHours as BusinessHours | null) ?? null,
      timezone: rows[0].timezone,
    };
  }

  /** Empty means unscoped — the whole knowledge base — never "no documents". */
  private async scopedDocumentIds(
    tenantId: string,
    agentId: string,
  ): Promise<string[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ kbDocumentId: agentKbDocuments.kbDocumentId })
          .from(agentKbDocuments)
          .where(eq(agentKbDocuments.agentId, agentId)),
      tenantId,
    );
    return rows.map((row) => row.kbDocumentId);
  }
}

function toConfig(
  row: {
    persona: string | null;
    forbiddenTopics: string[];
    confidenceThreshold: number;
    rerankEnabled: boolean;
    handoverAutoReturnMinutes: number;
    maxToolCallsPerTurn: number;
    businessHours: unknown;
    timezone: string | null;
    outOfHoursResponse: string | null;
    intakeFields: unknown;
  },
  kbDocumentIds: string[],
): ResolvedAgentConfig {
  return {
    persona: row.persona,
    forbiddenTopics: row.forbiddenTopics,
    confidenceThreshold: row.confidenceThreshold,
    rerankEnabled: row.rerankEnabled,
    handoverAutoReturnMinutes: row.handoverAutoReturnMinutes,
    maxToolCallsPerTurn: row.maxToolCallsPerTurn,
    kbDocumentIds,
    businessHours:
      (row.businessHours as ResolvedAgentConfig['businessHours']) ?? null,
    timezone: row.timezone,
    outOfHoursResponse: row.outOfHoursResponse,
    intakeFields: (row.intakeFields as IntakeField[] | null) ?? [],
  };
}
