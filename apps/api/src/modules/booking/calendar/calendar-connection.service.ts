// Clarly 2.0 S2: the stored calendar connection for a tenant. Owns the only
// path that encrypts or decrypts a calendar refresh token.
import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { AppLoggerService } from '../../core';
import { NotificationService } from '../../notifications/notification.service';
import { notificationContent } from '../../notifications/notification-content';
import { calendarConnections } from '../../persistence/drizzle/schema';
import { TenantContextService } from '../../tenant-context/tenant-context.service';
import { BspCredentialsEncryptionService } from '../../whatsapp/bsp-credentials-encryption.service';
import type { CalendarStatusRecord } from '../booking.dto';
import {
  CalendarProvider,
  type CalendarCredentials,
} from './calendar-provider.port';

export interface ActiveCalendar {
  calendarId: string;
  credentials: CalendarCredentials;
}

export class CalendarStateReplayError extends Error {
  constructor() {
    super('This calendar connect link was already used.');
    this.name = 'CalendarStateReplayError';
  }
}

@Injectable()
export class CalendarConnectionService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly encryption: BspCredentialsEncryptionService,
    private readonly provider: CalendarProvider,
    private readonly notifications: NotificationService,
    private readonly logger: AppLoggerService,
  ) {}

  async status(tenantId: string): Promise<CalendarStatusRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            provider: calendarConnections.provider,
            accountEmail: calendarConnections.accountEmail,
            status: calendarConnections.status,
            lastError: calendarConnections.lastError,
            createdAt: calendarConnections.createdAt,
          })
          .from(calendarConnections)
          .where(eq(calendarConnections.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return {
      configured: this.provider.isConfigured(),
      connection: row
        ? {
            provider: row.provider,
            accountEmail: row.accountEmail,
            status: row.status,
            lastError: row.lastError,
            connectedAt: row.createdAt,
          }
        : null,
    };
  }

  /** The decrypted credentials, only for an `active` connection. */
  async getActive(tenantId: string): Promise<ActiveCalendar | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(calendarConnections)
          .where(eq(calendarConnections.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    if (!row || row.status !== 'active') return null;
    const decrypted = this.encryption.decrypt(row.credentialsEncrypted);
    if (typeof decrypted.refreshToken !== 'string') return null;
    return {
      calendarId: row.calendarId,
      credentials: { refreshToken: decrypted.refreshToken },
    };
  }

  /** Whether the tenant has ANY connection row (active or broken). */
  async hasConnection(tenantId: string): Promise<boolean> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ id: calendarConnections.id })
          .from(calendarConnections)
          .where(eq(calendarConnections.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    return !!row;
  }

  /**
   * Saves (or replaces) the tenant's connection after a successful OAuth
   * exchange. A second callback carrying the same state nonce is refused:
   * the Redis jti claim already stops it, this is the database-side backstop.
   */
  async save(input: {
    tenantId: string;
    userId: string;
    nonce: string;
    credentials: CalendarCredentials;
    accountEmail: string | null;
  }): Promise<void> {
    const encrypted = this.encryption.encrypt({
      refreshToken: input.credentials.refreshToken,
    });
    await this.tenantContext.withTenantTx(async (tx) => {
      const [existing] = await tx
        .select({ stateNonce: calendarConnections.stateNonce })
        .from(calendarConnections)
        .where(eq(calendarConnections.tenantId, input.tenantId))
        .limit(1);
      if (existing?.stateNonce === input.nonce) {
        throw new CalendarStateReplayError();
      }
      await tx
        .insert(calendarConnections)
        .values({
          tenantId: input.tenantId,
          provider: 'google',
          accountEmail: input.accountEmail,
          credentialsEncrypted: encrypted,
          status: 'active',
          connectedBy: input.userId,
          stateNonce: input.nonce,
        })
        .onConflictDoUpdate({
          target: calendarConnections.tenantId,
          set: {
            provider: 'google',
            accountEmail: input.accountEmail,
            credentialsEncrypted: encrypted,
            status: 'active',
            lastError: null,
            connectedBy: input.userId,
            stateNonce: input.nonce,
            createdAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    }, input.tenantId);
  }

  /**
   * The grant is dead. Flips the row once (so one dead token is one
   * notification, not one per customer message) and tells the team.
   */
  async markNeedsReconnect(tenantId: string, error: string): Promise<void> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(calendarConnections)
          .set({
            status: 'needs_reconnect',
            lastError: error,
            updatedAt: sql`now()`,
          })
          .where(
            sql`${calendarConnections.tenantId} = ${tenantId} and ${calendarConnections.status} = 'active'`,
          )
          .returning({ accountEmail: calendarConnections.accountEmail }),
      tenantId,
    );
    if (rows.length === 0) return;
    this.logger.warn(
      `calendar for tenant ${tenantId} needs reconnecting: ${error}`,
      'CalendarConnectionService',
    );
    try {
      await this.notifications.record({
        tenantId,
        ...notificationContent.calendarNeedsReconnect({
          account: rows[0].accountEmail ?? 'Google Calendar',
        }),
        severity: 'critical',
        entityType: 'calendar',
        entityId: tenantId,
        dedupKey: `calendar_needs_reconnect:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
      });
    } catch (notifyError) {
      this.logger.error(
        `could not record calendar_needs_reconnect for tenant ${tenantId}: ${
          notifyError instanceof Error
            ? notifyError.message
            : String(notifyError)
        }`,
        undefined,
        'CalendarConnectionService',
      );
    }
  }

  /** Revokes at Google (best effort) and deletes the row. Returns whether there was one. */
  async disconnect(tenantId: string): Promise<boolean> {
    const active = await this.getActive(tenantId).catch(() => null);
    if (active) await this.provider.revoke(active.credentials);
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(calendarConnections)
          .where(eq(calendarConnections.tenantId, tenantId))
          .returning({ id: calendarConnections.id }),
      tenantId,
    );
    return rows.length > 0;
  }
}
