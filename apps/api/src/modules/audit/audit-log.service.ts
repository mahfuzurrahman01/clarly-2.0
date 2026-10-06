// Platform (AuditModule): writing and reading the audit trail.
//
// Writes come from AuditInterceptor only. There is no public "record whatever
// you like" path, deliberately — an audit log that any caller can write
// arbitrary rows into is not a record of what the system did, it is a record
// of what someone said the system did.
//
// Reads resolve the actor's email through TenantAuthProvisioningPort rather
// than storing it, so an entry never goes stale against a renamed account. A
// removed team member is not in the directory any more, so their entries come
// back with a null email and their user id intact — their actions stay
// attributable, which is exactly when an audit log matters most.
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import { AppLoggerService } from '../core';
import { TenantAuthProvisioningPort } from '../onboarding/ports/tenant-auth-provisioning.port';
import { auditLog, type AuditOutcome } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { AuditLogEntry, ListAuditLogQuery } from './audit-log.dto';

export interface RecordAuditInput {
  tenantId: string;
  actorUserId: string;
  actorRole: string | null;
  method: string;
  route: string;
  targetId: string | null;
  statusCode: number;
  outcome: AuditOutcome;
  /** English. */
  detail: string | null;
  /** Catalogue key `detail` was rendered from (audit-detail-catalog.ts); null when the handler gave none. */
  detailKey?: string | null;
  detailParams?: Readonly<Record<string, string | number>> | null;
}

@Injectable()
export class AuditLogService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly provisioning: TenantAuthProvisioningPort,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Appends one entry. Never throws.
   *
   * A failed audit write must not turn a successful admin action into a 500 —
   * the tenant already deleted the document; failing their request now would
   * be a lie about what happened, and retrying it would double the effect. So
   * a write failure is logged loudly and swallowed. That is a real, accepted
   * gap in the completeness guarantee, and it is the right trade: the
   * alternative is worse.
   */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.tenantContext.withTenantTx(
        (tx) =>
          tx.insert(auditLog).values({
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            method: input.method,
            route: input.route,
            targetId: input.targetId,
            statusCode: input.statusCode,
            outcome: input.outcome,
            detail: input.detail,
            detailKey: input.detailKey ?? null,
            detailParams: input.detailParams ? { ...input.detailParams } : null,
          }),
        input.tenantId,
      );
    } catch (error) {
      this.logger.error(
        `AuditLogService: FAILED to record ${input.method} ${input.route} by ${input.actorUserId} in tenant ${input.tenantId} — the action happened but is NOT in the audit trail: ${
          error instanceof Error ? error.message : String(error)
        }`,
        AuditLogService.name,
      );
    }
  }

  /** Newest first, keyset-paged on `createdAt` so a page boundary is stable while new entries land. */
  async list(
    tenantId: string,
    query: ListAuditLogQuery,
  ): Promise<AuditLogEntry[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(auditLog)
          .where(
            query.before
              ? and(
                  eq(auditLog.tenantId, tenantId),
                  lt(auditLog.createdAt, query.before),
                )
              : eq(auditLog.tenantId, tenantId),
          )
          .orderBy(desc(auditLog.createdAt))
          .limit(query.limit),
      tenantId,
    );

    const emails = await this.actorEmails(tenantId);

    return rows.map((row) => ({
      id: row.id,
      actorUserId: row.actorUserId,
      actorEmail: emails.get(row.actorUserId) ?? null,
      actorRole: row.actorRole,
      method: row.method,
      route: row.route,
      targetId: row.targetId,
      statusCode: row.statusCode,
      outcome: row.outcome,
      detail: row.detail,
      detailKey: row.detailKey ?? null,
      detailParams: row.detailParams ?? null,
      createdAt: row.createdAt,
    }));
  }

  /**
   * One directory lookup per page, not per row.
   *
   * A directory that cannot be reached yields an empty map rather than an
   * error: the log itself is the record, and emails are a convenience laid
   * over it. Losing the convenience must not lose the record.
   */
  private async actorEmails(tenantId: string): Promise<Map<string, string>> {
    try {
      const members = await this.provisioning.listTeamMembers(tenantId);
      return new Map(members.map((member) => [member.userId, member.email]));
    } catch (error) {
      this.logger.warn(
        `AuditLogService: could not resolve actor emails for tenant ${tenantId}, returning ids only: ${
          error instanceof Error ? error.message : String(error)
        }`,
        AuditLogService.name,
      );
      return new Map();
    }
  }
}
