// F9 step 1 (docs/decisions/F9-agent-configuration.md): proves migration
// 0027's backfill against real Postgres, executing the SHIPPED SQL rather
// than a copy of it — the file is read from disk and its backfill block run
// as-is.
//
// This exists because the first version of that backfill was a plain
// cross-tenant `INSERT ... SELECT`, which reads zero rows and inserts
// nothing: `tenant_policy`/`agents`/`agent_versions` are all FORCE ROW LEVEL
// SECURITY, owned by the same role that runs migrations (`app_user`, no
// BYPASSRLS), and FORCE means the owner is filtered too. It reported success
// and did nothing. A unit test could not have caught that; only real
// Postgres with real policies can.
//
// Requires real Postgres. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { CoreModule } from '../../src/modules/core/core.module';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import {
  agents,
  agentVersions,
  tenantPolicy,
  tenants,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';

const MIGRATION_PATH = join(
  __dirname,
  '../../src/modules/persistence/drizzle/migrations/0027_agents-and-agent-versions.sql',
);

/** The backfill half of the migration, lifted verbatim so this test exercises the shipped statement rather than a paraphrase of it. */
async function backfillSql(): Promise<string> {
  const file = await readFile(MIGRATION_PATH, 'utf8');
  const start = file.indexOf('DO $backfill$');
  if (start === -1) {
    throw new Error(
      'Could not find the backfill block in 0027 — this test reads the shipped SQL and must be updated with it.',
    );
  }
  return file.slice(start);
}

describe('F9 step 1 — agents/agent_versions backfill (migration 0027)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;

  const tenantId = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [CoreModule, PersistenceModule, TenantContextModule],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'F9 Backfill Tenant' }),
    );

    // The policy row this tenant's agent must be derived from. Values are
    // deliberately non-default so a backfill that silently wrote defaults
    // instead of copying would fail rather than pass.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantPolicy).values({
          tenantId,
          confidenceThreshold: 0.42,
          forbiddenTopics: ['legal advice', 'medical advice'],
          tonePersonaOverride: 'Warm, direct, never pushy.',
          rerankEnabled: false,
          stuckTicketThresholdMinutes: 33,
        }),
      tenantId,
    );

    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values({
        tenantId,
        phoneNumberId: `f9-${randomUUID()}`,
        bspCredentialsEncrypted: 'not-a-real-credential',
      }),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('creates exactly one published agent whose configuration mirrors tenant_policy field for field', async () => {
    const backfill = await backfillSql();
    await persistence.runAdminQuery((db) => db.execute(sql.raw(backfill)));

    const [agent] = await tenantContext.withTenantTx(
      (tx) => tx.select().from(agents).where(eq(agents.tenantId, tenantId)),
      tenantId,
    );

    expect(agent).toBeDefined();
    expect(agent.status).toBe('published');
    expect(agent.publishedVersionId).not.toBeNull();
    // Exactly one number on this tenant, so the backfill binds it.
    expect(agent.whatsappNumberId).not.toBeNull();

    const [version] = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(agentVersions)
          .where(eq(agentVersions.agentId, agent.id)),
      tenantId,
    );

    expect(version.version).toBe(1);
    expect(version.publishedAt).not.toBeNull();
    expect(agent.publishedVersionId).toBe(version.id);

    // Carried over — a mismatch here means live agents would start behaving
    // differently the moment step 2 switches the respond path over.
    expect(version.persona).toBe('Warm, direct, never pushy.');
    expect(version.forbiddenTopics).toEqual(['legal advice', 'medical advice']);
    expect(version.confidenceThreshold).toBe(0.42);
    expect(version.rerankEnabled).toBe(false);
    expect(version.stuckTicketThresholdMinutes).toBe(33);

    // New fields sit at values that render NOTHING, which is what makes the
    // backfilled configuration produce a byte-identical prompt to today's.
    expect(version.roleDescription).toBeNull();
    expect(version.tone).toBeNull();
    expect(version.greeting).toBeNull();
    expect(version.outOfScopeResponse).toBeNull();
    expect(version.businessHours).toBeNull();
    expect(version.languages).toEqual([]);
    expect(version.escalationTriggers).toEqual([]);

    // The two knobs that replace platform constants default to those
    // constants' current values.
    expect(version.handoverAutoReturnMinutes).toBe(60);
    expect(version.maxToolCallsPerTurn).toBe(2);
  });

  it('is idempotent — re-running creates no second agent', async () => {
    const backfill = await backfillSql();
    await persistence.runAdminQuery((db) => db.execute(sql.raw(backfill)));

    const rows = await tenantContext.withTenantTx(
      (tx) => tx.select().from(agents).where(eq(agents.tenantId, tenantId)),
      tenantId,
    );

    expect(rows).toHaveLength(1);
  });

  it('leaves a tenant with no policy row without an agent, rather than inventing default configuration for it', async () => {
    const bareTenantId = randomUUID();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: bareTenantId, name: 'F9 Bare Tenant' }),
    );

    try {
      const backfill = await backfillSql();
      await persistence.runAdminQuery((db) => db.execute(sql.raw(backfill)));

      const rows = await tenantContext.withTenantTx(
        (tx) =>
          tx.select().from(agents).where(eq(agents.tenantId, bareTenantId)),
        bareTenantId,
      );

      // Feature 2.5/T15's rule: a missing policy row is a configuration gap
      // to surface, never a set of defaults to guess.
      expect(rows).toHaveLength(0);
    } finally {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(eq(tenants.id, bareTenantId)),
      );
    }
  });

  it('keeps one tenant of agents invisible to another (RLS on the new tables)', async () => {
    const otherTenantId = randomUUID();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: otherTenantId, name: 'F9 Other Tenant' }),
    );

    try {
      const rows = await tenantContext.withTenantTx(
        (tx) => tx.select().from(agents),
        otherTenantId,
      );

      expect(rows.every((row) => row.tenantId === otherTenantId)).toBe(true);
    } finally {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(eq(tenants.id, otherTenantId)),
      );
    }
  });
});
