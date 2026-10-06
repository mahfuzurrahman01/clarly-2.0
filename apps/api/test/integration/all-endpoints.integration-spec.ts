// Comprehensive endpoint coverage test: hits every controller route against
// real Postgres/Redis. Verifies auth (401 without token, 403 for wrong role),
// happy-path responses, and validation (400 for bad input).
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Server } from 'node:http';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import { OnboardingModule } from '../../src/modules/onboarding/onboarding.module';
import { KanbanModule } from '../../src/modules/kanban/kanban.module';
import { InboxModule } from '../../src/modules/inbox/inbox.module';
import { AgentConfigModule } from '../../src/modules/agent-config/agent-config.module';
import { MetricsModule } from '../../src/modules/metrics/metrics.module';
import { BillingModule } from '../../src/modules/billing/billing.module';
import { AuditModule } from '../../src/modules/audit/audit.module';
import { DataExportModule } from '../../src/modules/data-export/data-export.module';
import { CustomerModule } from '../../src/modules/customer/customer.module';
import { OutboundModule } from '../../src/modules/outbound/outbound.module';
import { NotificationsModule } from '../../src/modules/notifications/notifications.module';
import { TemplatesModule } from '../../src/modules/templates/templates.module';
import { KnowledgeBaseModule } from '../../src/modules/knowledge-base/knowledge-base.module';
import { ObservabilityModule } from '../../src/modules/observability/observability.module';
import { TenantLifecycleModule } from '../../src/modules/tenant-lifecycle/tenant-lifecycle.module';
import { tenants } from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signAdminToken(secret: string, tenantId: string): string {
  return jwt.sign(
    {
      sub: randomUUID(),
      role: 'authenticated',
      app_metadata: { tenant_id: tenantId, app_role: 'admin' },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

function signAgentToken(secret: string, tenantId: string): string {
  return jwt.sign(
    {
      sub: randomUUID(),
      role: 'authenticated',
      app_metadata: { tenant_id: tenantId, app_role: 'agent' },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

function signFreshSignupToken(secret: string): string {
  return jwt.sign(
    {
      sub: randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

function expiredToken(secret: string, tenantId: string): string {
  return jwt.sign(
    {
      sub: randomUUID(),
      role: 'authenticated',
      app_metadata: { tenant_id: tenantId, app_role: 'admin' },
      exp: Math.floor(Date.now() / 1000) - 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('All endpoints (comprehensive coverage)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let httpServer: INestApplication;
  let jwtSecret: string;
  const tenantId = randomUUID();
  const createdTenantIds: string[] = [tenantId];

  function server(): Server {
    return httpServer.getHttpServer() as Server;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        // Onboarding
        OnboardingModule,
        // Product shell
        KanbanModule,
        InboxModule,
        AgentConfigModule,
        MetricsModule,
        BillingModule,
        AuditModule,
        DataExportModule,
        CustomerModule,
        OutboundModule,
        NotificationsModule,
        TemplatesModule,
        KnowledgeBaseModule,
        ObservabilityModule,
        TenantLifecycleModule,
      ],
    }).compile();

    persistence = moduleRef.get(PersistenceService);
    jwtSecret = moduleRef.get(AppConfigService).supabaseJwtSecret;

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'E2E Test Tenant' }),
    );

    httpServer = moduleRef.createNestApplication();
    await httpServer.init();
  });

  afterAll(async () => {
    if (createdTenantIds.length > 0) {
      await persistence.runAdminQuery((db) =>
        db.delete(tenants).where(inArray(tenants.id, createdTenantIds)),
      );
    }
    await httpServer.close();
  });

  const adminToken = () => signAdminToken(jwtSecret, tenantId);
  const agentToken = () => signAgentToken(jwtSecret, tenantId);

  // ========================================================================
  // 1. PUBLIC ENDPOINTS (no auth)
  // ========================================================================

  describe('Public endpoints', () => {
    it('GET /health — returns 200 with both deps up', async () => {
      const res = await request(server()).get('/health').expect(200);
      expect(res.body).toMatchObject({
        status: 'ok',
        dependencies: { postgres: true, redis: true },
      });
    });

    it('GET /health — returns 503 when a dep is down (not testable here)', async () => {
      // Health always returns 200 in a healthy environment; the 503 path
      // requires killing Postgres or Redis which we don't do in tests.
    });
  });

  // ========================================================================
  // 2. ONBOARDING — SIGNUP (no tenant claim)
  // ========================================================================

  describe('POST /onboarding/signup', () => {
    // Signup requires TENANT_PROVISIONING_PROVIDER=none and no Supabase
    // project — the real .env may have a Supabase URL configured, which
    // makes this call try to look up the user in Supabase and 500. The
    // endpoint itself is covered by tenant-signup.integration-spec.ts.
    // We test the 401/400 paths here instead.
    it('rejects 401 without token', async () => {
      await request(server())
        .post('/onboarding/signup')
        .send({ tenantName: 'No Auth' })
        .expect(401);
    });

    it('rejects 400 with empty body', async () => {
      const token = signFreshSignupToken(jwtSecret);
      await request(server())
        .post('/onboarding/signup')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('rejects 409 if token already has tenant_id', async () => {
      const token = jwt.sign(
        {
          sub: randomUUID(),
          exp: Math.floor(Date.now() / 1000) + 3600,
          app_metadata: { tenant_id: randomUUID() },
        },
        jwtSecret,
        { algorithm: 'HS256', noTimestamp: true },
      );
      await request(server())
        .post('/onboarding/signup')
        .set('Authorization', `Bearer ${token}`)
        .send({ tenantName: 'Already Has Tenant' })
        .expect(409);
    });
  });

  // ========================================================================
  // 3. AUTH GUARD BOUNDARY (expired / missing token)
  // ========================================================================

  describe('Auth guard', () => {
    it('rejects expired token with 401', async () => {
      await request(server())
        .get('/onboarding/tenant')
        .set('Authorization', `Bearer ${expiredToken(jwtSecret, tenantId)}`)
        .expect(401);
    });

    it('rejects malformed bearer with 401', async () => {
      await request(server())
        .get('/onboarding/tenant')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
    });

    it('rejects missing Authorization header with 401', async () => {
      await request(server()).get('/onboarding/tenant').expect(401);
    });
  });

  // ========================================================================
  // 4. ONBOARDING — TENANT (both roles)
  // ========================================================================

  describe('GET /onboarding/tenant', () => {
    it('admin can read tenant', async () => {
      const res = await request(server())
        .get('/onboarding/tenant')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
      expect(res.body).toMatchObject({
        id: tenantId,
        name: expect.any(String),
      });
    });

    it('agent can also read tenant (ungated)', async () => {
      await request(server())
        .get('/onboarding/tenant')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(200);
    });
  });

  // ========================================================================
  // 5. ONBOARDING — TENANT POLICY (admin-only)
  // ========================================================================

  describe('GET/PATCH /onboarding/tenant-policy', () => {
    it('admin can read policy', async () => {
      await request(server())
        .get('/onboarding/tenant-policy')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/onboarding/tenant-policy')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });

    it('admin can upsert policy', async () => {
      const res = await request(server())
        .patch('/onboarding/tenant-policy')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ stuckTicketThresholdMinutes: 45 })
        .expect(200);
      expect(res.body).toMatchObject({
        stuckTicketThresholdMinutes: 45,
      });
    });
  });

  // ========================================================================
  // 6. ONBOARDING — TEAM (admin-only)
  // ========================================================================

  describe('GET/PATCH/DELETE /onboarding/team', () => {
    it('admin can list team', async () => {
      await request(server())
        .get('/onboarding/team')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/onboarding/team')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 7. ONBOARDING — TEAM INVITE (admin-only)
  // ========================================================================

  describe('POST /onboarding/team/invite', () => {
    it('admin can invite', async () => {
      const res = await request(server())
        .post('/onboarding/team/invite')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email: 'test@example.com', appRole: 'agent' })
        .expect(201);
      expect(res.body).toMatchObject({ email: 'test@example.com' });
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .post('/onboarding/team/invite')
        .set('Authorization', `Bearer ${agentToken()}`)
        .send({ email: 'nope@example.com', appRole: 'agent' })
        .expect(403);
    });

    it('rejects 400 with invalid email', async () => {
      await request(server())
        .post('/onboarding/team/invite')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ email: 'not-an-email', appRole: 'agent' })
        .expect(400);
    });
  });

  // ========================================================================
  // 8. KANBAN (both roles — ungated)
  // ========================================================================

  describe('GET /kanban/tickets (both roles)', () => {
    it('admin can list tickets', async () => {
      await request(server())
        .get('/kanban/tickets')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent can also list tickets (ungated)', async () => {
      await request(server())
        .get('/kanban/tickets')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(200);
    });
  });

  describe('GET /kanban/tickets/config', () => {
    it('returns board config', async () => {
      const res = await request(server())
        .get('/kanban/tickets/config')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
      expect(res.body).toMatchObject({
        stuckTicketThresholdMinutes: expect.any(Number),
      });
    });
  });

  describe('GET /kanban/tickets/team', () => {
    it('returns team members', async () => {
      await request(server())
        .get('/kanban/tickets/team')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });
  });

  // ========================================================================
  // 9. INBOX / CONVERSATIONS (both roles — ungated)
  // ========================================================================

  describe('GET /conversations (both roles)', () => {
    it('admin can list conversations', async () => {
      await request(server())
        .get('/conversations')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent can also list conversations (ungated)', async () => {
      await request(server())
        .get('/conversations')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(200);
    });
  });

  describe('GET /conversations/:id', () => {
    it('returns 404 for non-existent conversation', async () => {
      await request(server())
        .get(`/conversations/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 10. AGENTS (admin-only)
  // ========================================================================

  describe('GET/POST /agents', () => {
    it('admin can list agents', async () => {
      await request(server())
        .get('/agents')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/agents')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });

    it('admin can create an agent', async () => {
      const res = await request(server())
        .post('/agents')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ name: 'Test Agent' })
        .expect(201);
      expect(res.body).toMatchObject({
        name: 'Test Agent',
        id: expect.any(String),
      });
    });
  });

  describe('GET /agents/numbers', () => {
    it('admin can list WhatsApp numbers', async () => {
      await request(server())
        .get('/agents/numbers')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });
  });

  // ========================================================================
  // 11. TEMPLATES (both roles for read, admin for write)
  // ========================================================================

  describe('GET /templates', () => {
    it('admin can list templates', async () => {
      await request(server())
        .get('/templates')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent can also list templates (ungated read)', async () => {
      await request(server())
        .get('/templates')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(200);
    });
  });

  describe('POST /templates', () => {
    it('admin can create a template', async () => {
      const res = await request(server())
        .post('/templates')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({
          kind: 'canned_reply',
          name: 'Test Canned Reply',
          body: 'Hello {{1}}!',
          variables: [{ position: 1, label: 'name', example: null }],
        })
        .expect(201);
      expect(res.body).toMatchObject({ name: 'Test Canned Reply' });
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .post('/templates')
        .set('Authorization', `Bearer ${agentToken()}`)
        .send({ kind: 'canned_reply', name: 'No', body: 'Hi' })
        .expect(403);
    });
  });

  // ========================================================================
  // 12. METRICS (admin-only)
  // ========================================================================

  describe('GET /metrics/*', () => {
    it('admin can read resolution rate', async () => {
      const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      await request(server())
        .get(`/metrics/resolution-rate?from=${from}&to=${to}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      await request(server())
        .get(`/metrics/resolution-rate?from=${from}&to=${to}`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });

    it('admin can read escalation breakdown', async () => {
      const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      await request(server())
        .get(`/metrics/escalation-breakdown?from=${from}&to=${to}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('admin can read knowledge gaps', async () => {
      const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const to = new Date().toISOString().slice(0, 10);
      await request(server())
        .get(`/metrics/knowledge-gaps?from=${from}&to=${to}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });
  });

  // ========================================================================
  // 13. BILLING (admin-only)
  // ========================================================================

  describe('GET /billing/*', () => {
    it('admin can list plans', async () => {
      await request(server())
        .get('/billing/plans')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('admin can get subscription', async () => {
      await request(server())
        .get('/billing/subscription')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('admin can get usage', async () => {
      await request(server())
        .get('/billing/usage')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/billing/plans')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 14. AUDIT LOG (admin-only)
  // ========================================================================

  describe('GET /audit-log', () => {
    it('admin can read audit log', async () => {
      await request(server())
        .get('/audit-log')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/audit-log')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 15. DATA EXPORTS (admin-only)
  // ========================================================================

  describe('GET /data-exports', () => {
    it('admin can list exports', async () => {
      await request(server())
        .get('/data-exports')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/data-exports')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 16. CUSTOMER CONSENT (admin-only)
  // ========================================================================

  describe('GET /customers/consent', () => {
    it('admin can read consent', async () => {
      await request(server())
        .get('/customers/consent?phone=%2B1234567890')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/customers/consent?phone=%2B1234567890')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 16b. CUSTOMER INTENT LABEL (Feature 18 — both roles, ungated)
  // ========================================================================

  describe('/customers/:customerId/label (Feature 18)', () => {
    // A well-formed uuid this tenant has no customer for — which is also
    // exactly what another tenant's customer id looks like from here.
    const unknownCustomerId = '00000000-0000-4000-8000-000000000123';

    it('requires a token', async () => {
      await request(server())
        .get(`/customers/${unknownCustomerId}/label`)
        .expect(401);
    });

    it('404s an unknown or cross-tenant customer on read', async () => {
      await request(server())
        .get(`/customers/${unknownCustomerId}/label`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('404s an unknown or cross-tenant customer on override — no write, and no hint that the id exists elsewhere', async () => {
      await request(server())
        .put(`/customers/${unknownCustomerId}/label`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .send({ label: 'hot' })
        .expect(404);
    });

    it('rejects a non-uuid customer id with 400', async () => {
      await request(server())
        .get('/customers/not-a-uuid/label')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(400);
    });

    it('rejects an empty label with 400', async () => {
      await request(server())
        .put(`/customers/${unknownCustomerId}/label`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .send({ label: '' })
        .expect(400);
    });

    it('is ungated by role — an agent may correct a label, not just an admin', async () => {
      // Proven by the ABSENCE of a 403: the agent token gets the same 404 an
      // admin does, rather than being turned away at the role gate.
      await request(server())
        .get(`/customers/${unknownCustomerId}/label`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 17. OUTBOUND WEBHOOKS (admin-only)
  // ========================================================================

  describe('GET /outbound/webhooks', () => {
    it('admin can list outbound webhooks', async () => {
      await request(server())
        .get('/outbound/webhooks')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/outbound/webhooks')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 18. NOTIFICATIONS (both roles — ungated)
  // ========================================================================

  describe('GET /notifications (both roles)', () => {
    it('admin can list notifications', async () => {
      await request(server())
        .get('/notifications')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent can also list notifications (ungated)', async () => {
      await request(server())
        .get('/notifications')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(200);
    });

    it('admin can get unread count', async () => {
      await request(server())
        .get('/notifications/unread-count')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });
  });

  // ========================================================================
  // 19. KNOWLEDGE BASE (admin-only)
  // ========================================================================

  describe('GET /knowledge-base/documents', () => {
    it('admin can list KB documents', async () => {
      await request(server())
        .get('/knowledge-base/documents')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/knowledge-base/documents')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 20. TENANT LIFECYCLE (admin-only)
  // ========================================================================

  describe('GET /onboarding/tenant/closure', () => {
    it('admin can check closure status', async () => {
      await request(server())
        .get('/onboarding/tenant/closure')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('agent is rejected with 403', async () => {
      await request(server())
        .get('/onboarding/tenant/closure')
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);
    });
  });

  // ========================================================================
  // 21. AGENT CONFIG — VERSIONS, KNOWLEDGE, SANDBOX (admin-only)
  // ========================================================================

  describe('Agent config sub-routes', () => {
    let agentId: string;

    beforeAll(async () => {
      // Create an agent to exercise sub-routes against
      const res = await request(server())
        .post('/agents')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ name: 'Sub-route Agent' })
        .expect(201);
      agentId = res.body.id;
    });

    it('GET /agents/:id — get one agent', async () => {
      await request(server())
        .get(`/agents/${agentId}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('GET /agents/:id/versions — version history', async () => {
      await request(server())
        .get(`/agents/${agentId}/versions`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('GET /agents/:id/knowledge — knowledge scope', async () => {
      await request(server())
        .get(`/agents/${agentId}/knowledge`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(200);
    });

    it('PATCH /agents/:id — edit agent', async () => {
      await request(server())
        .patch(`/agents/${agentId}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ name: 'Updated Agent' })
        .expect(200);
    });

    it('POST /agents/:id/publish — publish agent', async () => {
      await request(server())
        .post(`/agents/${agentId}/publish`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(201);
    });

    it('POST /agents/:id/archive — archive agent', async () => {
      await request(server())
        .post(`/agents/${agentId}/archive`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(201);
    });

    it('agent is rejected with 403 on all sub-routes', async () => {
      await request(server())
        .get(`/agents/${agentId}`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .expect(403);

      await request(server())
        .patch(`/agents/${agentId}`)
        .set('Authorization', `Bearer ${agentToken()}`)
        .send({ name: 'No' })
        .expect(403);
    });
  });

  // ========================================================================
  // 22. BILLING CHECKOUT / PORTAL (admin-only)
  // ========================================================================

  describe('POST /billing/checkout', () => {
    it('rejects 400 with missing planId', async () => {
      await request(server())
        .post('/billing/checkout')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({})
        .expect(400);
    });
  });

  describe('POST /billing/portal', () => {
    it('rejects 400 with missing returnUrl', async () => {
      await request(server())
        .post('/billing/portal')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({})
        .expect(400);
    });
  });

  // ========================================================================
  // 23. WEBHOOK ENDPOINTS (no auth — BSP/Stripe signatures)
  //     Note: WebhookModule/BillingWebhookController are excluded because
  //     importing them registers BullMQ Workers that compete for queue jobs
  //     with other test files. These endpoints are covered by
  //     webhook-channel.integration-spec.ts and billing.integration-spec.ts.
  // ========================================================================

  // ========================================================================
  // 24. KANBAN TICKET OPERATIONS (create + claim/resolve flow)
  // ========================================================================

  describe('Kanban ticket lifecycle', () => {
    // Note: Creating a ticket requires a real conversation + customer,
    // which requires a real inbound webhook. In integration tests we
    // can only verify the endpoints exist and respond correctly to
    // missing resources (404 on claim/resolve of non-existent ticket).

    it('GET /kanban/tickets/:id — returns 404 for non-existent ticket', async () => {
      await request(server())
        .get(`/kanban/tickets/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /kanban/tickets/:id/claim — returns 404 for non-existent ticket', async () => {
      await request(server())
        .post(`/kanban/tickets/${randomUUID()}/claim`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /kanban/tickets/:id/resolve — returns 404 for non-existent ticket', async () => {
      await request(server())
        .post(`/kanban/tickets/${randomUUID()}/resolve`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /kanban/tickets/:id/assign — returns 404 for non-existent ticket (assigneeId: null is valid body)', async () => {
      await request(server())
        .post(`/kanban/tickets/${randomUUID()}/assign`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ assigneeId: null })
        .expect(404);
    });
  });

  // ========================================================================
  // 25. INBOX OPERATIONS (reply, handover, feedback)
  // ========================================================================

  describe('Inbox operations', () => {
    it('POST /conversations/:id/messages — returns 400 without clientMessageId (validation before existence check)', async () => {
      await request(server())
        .post(`/conversations/${randomUUID()}/messages`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ text: 'Hello' })
        .expect(400);
    });

    it('POST /conversations/:id/handover — returns 404 for non-existent conversation', async () => {
      await request(server())
        .post(`/conversations/${randomUUID()}/handover`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('GET /conversations/:id/messages — returns 404 for non-existent conversation', async () => {
      await request(server())
        .get(`/conversations/${randomUUID()}/messages`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 26. TEMPLATES SUB-OPERATIONS
  // ========================================================================

  describe('Template sub-operations', () => {
    it('GET /templates/:id — returns 404 for non-existent template', async () => {
      await request(server())
        .get(`/templates/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /templates/:id/submit — returns 404 for non-existent template', async () => {
      await request(server())
        .post(`/templates/${randomUUID()}/submit`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('DELETE /templates/:id — returns 404 for non-existent template', async () => {
      await request(server())
        .delete(`/templates/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 27. KB DOCUMENT OPERATIONS
  // ========================================================================

  describe('KB document operations', () => {
    it('GET /knowledge-base/documents/:id — returns 404 for non-existent doc', async () => {
      await request(server())
        .get(`/knowledge-base/documents/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('DELETE /knowledge-base/documents/:id — returns 404 for non-existent doc', async () => {
      await request(server())
        .delete(`/knowledge-base/documents/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /knowledge-base/documents — returns 400 without file', async () => {
      await request(server())
        .post('/knowledge-base/documents')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(400);
    });
  });

  // ========================================================================
  // 28. OUTBOUND WEBHOOK OPERATIONS
  // ========================================================================

  describe('Outbound webhook operations', () => {
    it('POST /outbound/webhooks — returns 400 with invalid URL', async () => {
      await request(server())
        .post('/outbound/webhooks')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({ url: 'not-a-url', events: ['ticket.escalated'] })
        .expect(400);
    });

    it('DELETE /outbound/webhooks/:id — returns 404 for non-existent webhook', async () => {
      await request(server())
        .delete(`/outbound/webhooks/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 29. DATA EXPORT OPERATIONS
  // ========================================================================

  describe('Data export operations', () => {
    it('GET /data-exports/:id — returns 404 for non-existent export', async () => {
      await request(server())
        .get(`/data-exports/${randomUUID()}`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('GET /data-exports/:id/download — returns 404 for non-existent export', async () => {
      await request(server())
        .get(`/data-exports/${randomUUID()}/download`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });
  });

  // ========================================================================
  // 30. NOTIFICATION OPERATIONS
  // ========================================================================

  describe('Notification operations', () => {
    it('POST /notifications/:id/read — returns 404 for non-existent notification', async () => {
      await request(server())
        .post(`/notifications/${randomUUID()}/read`)
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(404);
    });

    it('POST /notifications/read-all — returns 201 with count', async () => {
      const res = await request(server())
        .post('/notifications/read-all')
        .set('Authorization', `Bearer ${adminToken()}`)
        .expect(201);
      expect(res.body).toMatchObject({ marked: expect.any(Number) });
    });
  });
});
