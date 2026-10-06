// Gulf T3: the HTTP contract of the connect routes — real controller, real
// RolesGuard + EntitlementGuard + ZodValidationPipe over supertest, with
// ConnectService and BillingService faked at their boundary. req.auth is set
// by a stand-in for TenantAuthMiddleware (its own 401 path is covered by the
// whatsapp-connect integration spec against real JWTs).
import type { INestApplication } from '@nestjs/common';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'node:http';
import request from 'supertest';
import { RolesGuard } from '../../auth/roles.guard';
import { BillingService } from '../../billing/billing.service';
import { EntitlementGuard } from '../../billing/entitlement.guard';
import { ConnectController } from './connect.controller';
import { ConnectService } from './connect.service';

const TENANT = '7f0c5b5e-2c1d-4c1e-9a55-0c3a1d9c1a01';
const BODY = { code: 'CODE', wabaId: '1029', phoneNumberId: '1065' };

describe('ConnectController', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;
  const connect = {
    listNumbers: jest.fn(),
    completeEmbeddedSignup: jest.fn(),
  };
  const billing = { getForTenant: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ConnectController],
      providers: [
        RolesGuard,
        EntitlementGuard,
        { provide: ConnectService, useValue: connect },
        { provide: BillingService, useValue: billing },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    // Stand-in for TenantAuthMiddleware: `x-test-role` becomes req.auth.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = req.header('x-test-role');
      if (role) {
        req.auth = {
          userId: 'user-1',
          tenantId: TENANT,
          role: 'authenticated',
          appRole: role as 'admin' | 'agent',
        };
      }
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // A tenant mid-trial, no card on file (D16).
    billing.getForTenant.mockResolvedValue({
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 7 * 86_400_000),
      comped: false,
    });
    connect.completeEmbeddedSignup.mockResolvedValue({
      id: '5f0c5b5e-2c1d-4c1e-9a55-0c3a1d9c1a02',
      phoneNumberId: '1065',
      connectionState: 'active',
      connectionError: null,
      coexistence: false,
    });
  });

  describe('POST /whatsapp/connect/embedded-signup', () => {
    it('201s for an admin of a trialing tenant (no card gate, D16) and scopes the call to the caller tenant', async () => {
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'admin')
        .send(BODY);

      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        phoneNumberId: '1065',
        connectionState: 'active',
        coexistence: false,
      });
      expect(connect.completeEmbeddedSignup).toHaveBeenCalledWith(TENANT, BODY);
    });

    it('403s an agent-role caller', async () => {
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'agent')
        .send(BODY);
      expect(response.status).toBe(403);
      expect(connect.completeEmbeddedSignup).not.toHaveBeenCalled();
    });

    it('403s a request with no authenticated context', async () => {
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .send(BODY);
      expect(response.status).toBe(403);
      expect(connect.completeEmbeddedSignup).not.toHaveBeenCalled();
    });

    it('403s a tenant whose trial has lapsed (EntitlementGuard still applies)', async () => {
      billing.getForTenant.mockResolvedValue({
        status: 'trialing',
        trialEndsAt: new Date(Date.now() - 86_400_000),
        comped: false,
      });
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'admin')
        .send(BODY);
      expect(response.status).toBe(403);
      expect((response.body as { message: string }).message).toMatch(
        /Subscription is not active/,
      );
    });

    it.each([
      ['missing code', { wabaId: '1', phoneNumberId: '2' }],
      ['non-numeric wabaId', { code: 'C', wabaId: 'abc', phoneNumberId: '2' }],
      [
        'non-numeric phoneNumberId',
        { code: 'C', wabaId: '1', phoneNumberId: 'x' },
      ],
      ['a 4-digit pin', { ...BODY, pin: '1234' }],
      ['an unknown field', { ...BODY, accessToken: 'smuggled' }],
    ])('400s on %s without calling the service', async (_label, body) => {
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'admin')
        .send(body);
      expect(response.status).toBe(400);
      expect(connect.completeEmbeddedSignup).not.toHaveBeenCalled();
    });

    it('accepts an omitted phoneNumberId (coexistence) and a 6-digit pin', async () => {
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'admin')
        .send({ code: 'C', wabaId: '1029', pin: '012345' });
      expect(response.status).toBe(201);
      expect(connect.completeEmbeddedSignup).toHaveBeenCalledWith(TENANT, {
        code: 'C',
        wabaId: '1029',
        pin: '012345',
      });
    });

    it('passes the service 409 through', async () => {
      connect.completeEmbeddedSignup.mockRejectedValue(
        new ConflictException(
          'This WhatsApp number is already connected to another workspace.',
        ),
      );
      const response = await request(server())
        .post('/whatsapp/connect/embedded-signup')
        .set('x-test-role', 'admin')
        .send(BODY);
      expect(response.status).toBe(409);
    });
  });

  describe('GET /whatsapp/connect/numbers', () => {
    it('lists the caller tenant numbers with their connection state', async () => {
      connect.listNumbers.mockResolvedValue([
        {
          id: 'n1',
          phoneNumberId: '1065',
          connectionState: 'reconnect_required',
          connectionError: 'Turn off two-step verification',
        },
      ]);
      const response = await request(server())
        .get('/whatsapp/connect/numbers')
        .set('x-test-role', 'admin');
      expect(response.status).toBe(200);
      const [listed] = response.body as { connectionState: string }[];
      expect(listed.connectionState).toBe('reconnect_required');
      expect(connect.listNumbers).toHaveBeenCalledWith(TENANT);
    });
  });
});
