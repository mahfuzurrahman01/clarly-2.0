// Clarly 2.0 S1: the operator directory. The only reader and writer of
// `platform_admins`.
//
// `runAdminQuery` (no tenant GUC) is correct here and only here: the table is
// a platform table with no RLS, like `plans`. Nothing in this service touches
// a tenant-scoped table.
import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import {
  platformAdmins,
  type PlatformRole,
} from '../persistence/drizzle/schema';
import { PersistenceService } from '../persistence/persistence.service';

export interface PlatformAdminRecord {
  userId: string;
  email: string;
  role: PlatformRole;
  grantedBy: string | null;
  createdAt: Date;
}

@Injectable()
export class PlatformAdminService {
  constructor(private readonly persistence: PersistenceService) {}

  async findByUserId(userId: string): Promise<PlatformAdminRecord | null> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .select()
        .from(platformAdmins)
        .where(eq(platformAdmins.userId, userId))
        .limit(1),
    );
    return rows[0] ?? null;
  }

  async list(): Promise<PlatformAdminRecord[]> {
    return this.persistence.runAdminQuery((db) =>
      db.select().from(platformAdmins).orderBy(asc(platformAdmins.createdAt)),
    );
  }

  /**
   * Grants (or changes) an operator role. Idempotent on `userId`: granting
   * again updates the role and email rather than failing, so the bootstrap
   * script can be re-run safely.
   */
  async grant(input: {
    userId: string;
    email: string;
    role: PlatformRole;
    grantedBy: string | null;
  }): Promise<PlatformAdminRecord> {
    const email = input.email.trim().toLowerCase();
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .insert(platformAdmins)
        .values({
          userId: input.userId,
          email,
          role: input.role,
          grantedBy: input.grantedBy,
        })
        .onConflictDoUpdate({
          target: platformAdmins.userId,
          set: { email, role: input.role, grantedBy: input.grantedBy },
        })
        .returning(),
    );
    return rows[0];
  }

  /** Returns whether a row was removed. */
  async revoke(userId: string): Promise<boolean> {
    const rows = await this.persistence.runAdminQuery((db) =>
      db
        .delete(platformAdmins)
        .where(eq(platformAdmins.userId, userId))
        .returning({ userId: platformAdmins.userId }),
    );
    return rows.length > 0;
  }
}
