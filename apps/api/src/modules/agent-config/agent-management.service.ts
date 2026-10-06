// Product shell (AgentConfigModule, F9): the write path a tenant edits an
// agent through.
//
// The lifecycle is the whole point of this service, and it is small on
// purpose:
//   create   -> agent + version 1, DRAFT (never answers anyone yet)
//   update   -> writes the DRAFT version, creating one from the published
//               values if the agent has none
//   publish  -> stamps the draft published, points the agent at it
//
// A published version is never mutated after that stamp. Everything F9
// wants — rollback, "what changed between v3 and v4", and
// `agent_runs.agent_config_version` identifying configuration that still
// exists exactly as it ran — depends on that one rule holding.
import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { ConflictException } from '@nestjs/common';
import {
  agentKbDocuments,
  agents,
  agentVersions,
  kbDocuments,
  tenantPolicy,
  whatsappNumbers,
} from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  AgentConfigInput,
  AgentRecord,
  AgentVersionSummary,
} from './agent-config.dto.zod';

type VersionRow = typeof agentVersions.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

@Injectable()
export class AgentManagementService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(tenantId: string): Promise<AgentRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(agents)
          .where(eq(agents.tenantId, tenantId))
          .orderBy(desc(agents.createdAt)),
      tenantId,
    );

    const versions = await this.versionsFor(
      tenantId,
      rows.flatMap((row) =>
        [row.draftVersionId, row.publishedVersionId].filter(
          (id): id is string => id !== null,
        ),
      ),
    );

    return rows.map((row) => toRecord(row, versions));
  }

  async get(tenantId: string, agentId: string): Promise<AgentRecord> {
    const row = await this.requireAgent(tenantId, agentId);
    const versions = await this.versionsFor(
      tenantId,
      [row.draftVersionId, row.publishedVersionId].filter(
        (id): id is string => id !== null,
      ),
    );
    return toRecord(row, versions);
  }

  /** A new agent starts as a draft with no published version: it cannot answer a customer until someone publishes it deliberately. */
  async create(
    tenantId: string,
    userId: string,
    name: string,
    config: AgentConfigInput | undefined,
  ): Promise<AgentRecord> {
    const agentId = await this.withDuplicateNameAsConflict(name, () =>
      this.tenantContext.withTenantTx(async (tx) => {
        const [agent] = await tx
          .insert(agents)
          .values({ tenantId, name, status: 'draft' })
          .returning({ id: agents.id });

        const [version] = await tx
          .insert(agentVersions)
          .values({
            tenantId,
            agentId: agent.id,
            version: 1,
            createdBy: userId,
            ...toColumns(config ?? {}),
          })
          .returning({ id: agentVersions.id });

        await tx
          .update(agents)
          .set({ draftVersionId: version.id, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));

        return agent.id;
      }, tenantId),
    );

    return this.get(tenantId, agentId);
  }

  /**
   * Edits land on the draft, never on what customers are currently getting.
   * An agent with no draft gets one forked from its published version, so a
   * half-finished edit can never change live behaviour — the tenant has to
   * publish for that.
   */
  async update(
    tenantId: string,
    userId: string,
    agentId: string,
    name: string | undefined,
    config: AgentConfigInput | undefined,
    whatsappNumberId?: string | null,
  ): Promise<AgentRecord> {
    const agent = await this.requireAgent(tenantId, agentId);

    if (whatsappNumberId !== undefined) {
      await this.bindNumber(tenantId, agentId, whatsappNumberId);
    }

    await this.withDuplicateNameAsConflict(name, () =>
      this.tenantContext.withTenantTx(async (tx) => {
        if (name !== undefined) {
          await tx
            .update(agents)
            .set({ name, updatedAt: new Date() })
            .where(eq(agents.id, agentId));
        }

        if (config === undefined) return;

        if (agent.draftVersionId) {
          await tx
            .update(agentVersions)
            .set({ ...toColumns(config), updatedAt: new Date() })
            .where(eq(agentVersions.id, agent.draftVersionId));
          return;
        }

        // Fork the published values so an edit that sets one field does not
        // silently reset every other one to a column default.
        const [published] = agent.publishedVersionId
          ? await tx
              .select()
              .from(agentVersions)
              .where(eq(agentVersions.id, agent.publishedVersionId))
              .limit(1)
          : [];

        const [{ next }] = await tx
          .select({
            next: sql<number>`coalesce(max(${agentVersions.version}), 0) + 1`,
          })
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agentId));

        const [draft] = await tx
          .insert(agentVersions)
          .values({
            tenantId,
            agentId,
            version: Number(next),
            createdBy: userId,
            ...(published ? inheritedColumns(published) : {}),
            ...toColumns(config),
          })
          .returning({ id: agentVersions.id });

        await tx
          .update(agents)
          .set({ draftVersionId: draft.id, updatedAt: new Date() })
          .where(eq(agents.id, agentId));
      }, tenantId),
    );

    return this.get(tenantId, agentId);
  }

  /**
   * `agents_tenant_id_name_unique` is what actually enforces one name per
   * workspace, and a tenant tripping it is a 409, not a 500. Checked by
   * catching the violation rather than by SELECTing first: a pre-check races
   * two concurrent creates and still ends in the same unhandled error.
   */
  private async withDuplicateNameAsConflict<T>(
    name: string | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `An agent named "${name}" already exists in this workspace.`,
        );
      }
      throw error;
    }
  }

  /**
   * Binds (or unbinds) the number this agent answers on.
   *
   * Two checks, both refusals rather than silent corrections:
   *   - the number must belong to the caller's tenant. `whatsapp_numbers`
   *     carries NO row-level security (it is read before a tenant is known,
   *     during webhook routing), so this explicit filter is the only thing
   *     standing between a guessed uuid and another tenant's number.
   *   - a number answers for exactly one agent. Silently moving it would
   *     redirect live customer traffic away from an agent whose owner never
   *     asked for that.
   */
  private async bindNumber(
    tenantId: string,
    agentId: string,
    whatsappNumberId: string | null,
  ): Promise<void> {
    if (whatsappNumberId !== null) {
      const [number] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: whatsappNumbers.id })
            .from(whatsappNumbers)
            .where(
              and(
                eq(whatsappNumbers.id, whatsappNumberId),
                eq(whatsappNumbers.tenantId, tenantId),
              ),
            )
            .limit(1),
        tenantId,
      );
      if (!number) {
        throw new NotFoundException(
          `WhatsApp number ${whatsappNumberId} not found`,
        );
      }

      const [taken] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(
              and(
                eq(agents.tenantId, tenantId),
                eq(agents.whatsappNumberId, whatsappNumberId),
              ),
            )
            .limit(1),
        tenantId,
      );
      if (taken && taken.id !== agentId) {
        throw new ConflictException(
          `That number already answers as "${taken.name}". Unbind it there first.`,
        );
      }
    }

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(agents)
          .set({ whatsappNumberId, updatedAt: new Date() })
          .where(eq(agents.id, agentId)),
      tenantId,
    );
  }

  /**
   * Takes an agent out of service. The number binding is cleared with it:
   * an archived agent holding a number would block the replacement agent
   * from taking that traffic, which is exactly what someone archiving one
   * is usually trying to do.
   */
  async archive(tenantId: string, agentId: string): Promise<AgentRecord> {
    await this.requireAgent(tenantId, agentId);

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(agents)
          .set({
            status: 'archived',
            whatsappNumberId: null,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId)),
      tenantId,
    );

    // Archiving can leave exactly one published agent behind, which is when
    // the tenant-level mirror becomes unambiguous again.
    await this.mirrorToTenantPolicy(tenantId);
    return this.get(tenantId, agentId);
  }

  /**
   * The tenant's knowledge-base documents, and whether this agent is scoped
   * to each.
   *
   * `scopedToAll` is not derived by the caller from an empty list, because
   * "no documents selected" and "every document allowed" look identical in
   * the data and mean opposite things to a human reading the screen.
   */
  async knowledgeScope(
    tenantId: string,
    agentId: string,
  ): Promise<{
    scopedToAll: boolean;
    documents: { id: string; filename: string; selected: boolean }[];
  }> {
    await this.requireAgent(tenantId, agentId);

    const [documents, selected] = await Promise.all([
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: kbDocuments.id, filename: kbDocuments.filename })
            .from(kbDocuments)
            .where(eq(kbDocuments.tenantId, tenantId))
            .orderBy(kbDocuments.filename),
        tenantId,
      ),
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ kbDocumentId: agentKbDocuments.kbDocumentId })
            .from(agentKbDocuments)
            .where(eq(agentKbDocuments.agentId, agentId)),
        tenantId,
      ),
    ]);

    const selectedIds = new Set(selected.map((row) => row.kbDocumentId));
    return {
      scopedToAll: selectedIds.size === 0,
      documents: documents.map((document) => ({
        ...document,
        selected: selectedIds.has(document.id),
      })),
    };
  }

  /**
   * Replaces this agent's document scope.
   *
   * An empty list means "the whole knowledge base", not "nothing" — an agent
   * scoped to zero documents could answer nothing at all, which no tenant
   * intends and which would turn every question into an escalation.
   *
   * Every id is checked against the tenant's own documents first: a scope
   * silently containing an id that does not exist would look applied while
   * quietly widening or narrowing what the agent reads.
   */
  async setKnowledgeScope(
    tenantId: string,
    agentId: string,
    documentIds: string[],
  ): Promise<void> {
    await this.requireAgent(tenantId, agentId);

    const unique = [...new Set(documentIds)];

    if (unique.length > 0) {
      const owned = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: kbDocuments.id })
            .from(kbDocuments)
            .where(
              and(
                eq(kbDocuments.tenantId, tenantId),
                inArray(kbDocuments.id, unique),
              ),
            ),
        tenantId,
      );

      if (owned.length !== unique.length) {
        throw new NotFoundException(
          'One or more of those knowledge-base documents does not exist in this workspace',
        );
      }
    }

    await this.tenantContext.withTenantTx(async (tx) => {
      await tx
        .delete(agentKbDocuments)
        .where(eq(agentKbDocuments.agentId, agentId));

      if (unique.length > 0) {
        await tx.insert(agentKbDocuments).values(
          unique.map((kbDocumentId) => ({
            tenantId,
            agentId,
            kbDocumentId,
          })),
        );
      }
    }, tenantId);
  }

  /** The tenant's numbers and which agent each currently answers for. Never selects the encrypted credentials column. */
  async listNumbers(
    tenantId: string,
  ): Promise<
    { id: string; phoneNumberId: string; boundAgentId: string | null }[]
  > {
    const [numbers, bound] = await Promise.all([
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              id: whatsappNumbers.id,
              phoneNumberId: whatsappNumbers.phoneNumberId,
            })
            .from(whatsappNumbers)
            .where(eq(whatsappNumbers.tenantId, tenantId)),
        tenantId,
      ),
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({ id: agents.id, numberId: agents.whatsappNumberId })
            .from(agents)
            .where(eq(agents.tenantId, tenantId)),
        tenantId,
      ),
    ]);

    const byNumber = new Map(
      bound
        .filter((agent) => agent.numberId !== null)
        .map((agent) => [agent.numberId as string, agent.id]),
    );

    return numbers.map((number) => ({
      ...number,
      boundAgentId: byNumber.get(number.id) ?? null,
    }));
  }

  /**
   * Publishing is what makes a configuration live. Publishing an agent with
   * no draft is a no-op rather than an error — the tenant's intent ("what I
   * see should be live") is already true, and failing a button press that
   * changes nothing is noise.
   */
  async publish(tenantId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.requireAgent(tenantId, agentId);

    if (agent.draftVersionId) {
      await this.tenantContext.withTenantTx(async (tx) => {
        const now = new Date();
        await tx
          .update(agentVersions)
          .set({ publishedAt: now, updatedAt: now })
          .where(eq(agentVersions.id, agent.draftVersionId as string));

        await tx
          .update(agents)
          .set({
            status: 'published',
            publishedVersionId: agent.draftVersionId,
            draftVersionId: null,
            updatedAt: now,
          })
          .where(eq(agents.id, agentId));
      }, tenantId);
    }

    await this.mirrorToTenantPolicy(tenantId);
    return this.get(tenantId, agentId);
  }

  /**
   * Copies the published configuration back onto `tenant_policy`.
   *
   * `agent_versions` is authoritative for the respond path, but two
   * consumers have no per-turn agent to resolve against — the stuck-ticket
   * sweep and the kanban board config are tenant-level. Rather than leave
   * them reading values a tenant can no longer edit, publishing mirrors the
   * overlapping fields down to them.
   *
   * Only when the tenant has exactly ONE published agent. With several,
   * "the tenant's stuck-ticket threshold" has no single answer, and picking
   * one agent's silently would make the board show a threshold that does not
   * match what a given ticket was judged by. Those consumers become
   * agent-aware when tickets carry an agent; until then a multi-agent tenant
   * keeps whatever threshold it last had.
   */
  private async mirrorToTenantPolicy(tenantId: string): Promise<void> {
    const published = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            persona: agentVersions.persona,
            forbiddenTopics: agentVersions.forbiddenTopics,
            confidenceThreshold: agentVersions.confidenceThreshold,
            rerankEnabled: agentVersions.rerankEnabled,
            stuckTicketThresholdMinutes:
              agentVersions.stuckTicketThresholdMinutes,
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

    if (published.length !== 1) return;

    const [config] = published;
    const values = {
      tonePersonaOverride: config.persona,
      forbiddenTopics: config.forbiddenTopics,
      confidenceThreshold: config.confidenceThreshold,
      rerankEnabled: config.rerankEnabled,
      stuckTicketThresholdMinutes: config.stuckTicketThresholdMinutes,
      updatedAt: new Date(),
    };

    // Written directly rather than through TenantPolicyService so the module
    // graph stays one-directional: OnboardingModule depends on this module
    // for the legacy endpoint's write-through, and a dependency back the
    // other way would make that a cycle.
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantPolicy)
          .values({ tenantId, ...values })
          .onConflictDoUpdate({ target: tenantPolicy.tenantId, set: values }),
      tenantId,
    );
  }

  /**
   * The legacy `PATCH /onboarding/tenant-policy` path: applies those five
   * fields to the tenant's single published agent and publishes immediately.
   *
   * Without this, an edit through the old endpoint would write a row the
   * respond path no longer reads — the tenant changes their persona, sees a
   * 200, and nothing happens. A silent no-op is the worst possible outcome,
   * so the old endpoint keeps meaning what it always meant.
   *
   * Returns false when the tenant has no single published agent to apply it
   * to; the caller still writes `tenant_policy`, which is what the
   * tenant-level consumers read.
   */
  async applyLegacyPolicy(
    tenantId: string,
    userId: string,
    input: {
      tonePersonaOverride?: string | null;
      forbiddenTopics?: string[];
      confidenceThreshold?: number;
      rerankEnabled?: boolean;
      stuckTicketThresholdMinutes?: number;
    },
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(eq(agents.tenantId, tenantId), eq(agents.status, 'published')),
          ),
      tenantId,
    );

    if (rows.length !== 1) return false;

    await this.update(tenantId, userId, rows[0].id, undefined, {
      ...(input.tonePersonaOverride !== undefined && {
        persona: input.tonePersonaOverride,
      }),
      ...(input.forbiddenTopics !== undefined && {
        forbiddenTopics: input.forbiddenTopics,
      }),
      ...(input.confidenceThreshold !== undefined && {
        confidenceThreshold: input.confidenceThreshold,
      }),
      ...(input.rerankEnabled !== undefined && {
        rerankEnabled: input.rerankEnabled,
      }),
      ...(input.stuckTicketThresholdMinutes !== undefined && {
        stuckTicketThresholdMinutes: input.stuckTicketThresholdMinutes,
      }),
    });
    await this.publish(tenantId, rows[0].id);
    return true;
  }

  /** History, newest first — the surface a tenant rolls back from and diffs against. */
  async versions(
    tenantId: string,
    agentId: string,
  ): Promise<AgentVersionSummary[]> {
    await this.requireAgent(tenantId, agentId);

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agentId))
          .orderBy(desc(agentVersions.version)),
      tenantId,
    );

    return rows.map((row) => ({
      version: row.version,
      publishedAt: row.publishedAt,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      config: toConfig(row),
    }));
  }

  /** Another tenant's id is indistinguishable from a non-existent one, same rule as every other `:id` route. */
  private async requireAgent(
    tenantId: string,
    agentId: string,
  ): Promise<AgentRow> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(agents)
          .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
          .limit(1),
      tenantId,
    );

    if (rows.length === 0) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
    return rows[0];
  }

  private async versionsFor(
    tenantId: string,
    versionIds: string[],
  ): Promise<Map<string, VersionRow>> {
    if (versionIds.length === 0) return new Map();

    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(agentVersions)
          .where(
            sql`${agentVersions.id} in ${sql.raw(
              `(${versionIds.map((id) => `'${id}'::uuid`).join(',')})`,
            )}`,
          ),
      tenantId,
    );

    return new Map(rows.map((row) => [row.id, row]));
  }
}

function toRecord(
  agent: AgentRow,
  versions: Map<string, VersionRow>,
): AgentRecord {
  const draft = agent.draftVersionId
    ? versions.get(agent.draftVersionId)
    : undefined;
  const published = agent.publishedVersionId
    ? versions.get(agent.publishedVersionId)
    : undefined;
  // Draft first: showing published values while a draft exists would hide
  // the tenant's own unsaved intent from them.
  const effective = draft ?? published;

  return {
    id: agent.id,
    name: agent.name,
    status: agent.status as AgentRecord['status'],
    whatsappNumberId: agent.whatsappNumberId,
    publishedVersion: published?.version ?? null,
    hasUnpublishedChanges: draft !== undefined,
    config: effective ? toConfig(effective) : null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function toConfig(row: VersionRow): AgentVersionSummary['config'] {
  return {
    roleDescription: row.roleDescription,
    persona: row.persona,
    tone: row.tone as AgentVersionSummary['config']['tone'],
    languages: row.languages,
    greeting: row.greeting,
    outOfScopeResponse: row.outOfScopeResponse,
    forbiddenTopics: row.forbiddenTopics,
    businessHours: row.businessHours as Record<string, unknown> | null,
    timezone: row.timezone,
    outOfHoursResponse: row.outOfHoursResponse,
    escalationTriggers: row.escalationTriggers,
    intakeFields: row.intakeFields ?? [],
    confidenceThreshold: row.confidenceThreshold,
    rerankEnabled: row.rerankEnabled,
    stuckTicketThresholdMinutes: row.stuckTicketThresholdMinutes,
    handoverAutoReturnMinutes: row.handoverAutoReturnMinutes,
    maxToolCallsPerTurn: row.maxToolCallsPerTurn,
  };
}

/** Everything carried forward when forking a published version into a new draft — identity and lifecycle columns deliberately excluded. */
function inheritedColumns(row: VersionRow) {
  return toColumns(toConfig(row));
}

/** Only keys the caller actually sent are written, so a PATCH of one field leaves the rest of the draft alone. */
function toColumns(config: Partial<AgentConfigInput>) {
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) columns[key] = value;
  }
  return columns;
}
