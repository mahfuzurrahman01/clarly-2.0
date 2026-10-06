// Gulf T7 (D7): the HTTP contract Meta's App Dashboard exercises — the real
// controller, verifier and signed_request parser over real HTTP (supertest),
// with the two data services faked at their boundary.
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppConfigService, AppLoggerService } from '../core';
import { WebhookRateLimiterService } from '../webhook/webhook-rate-limiter.service';
import { MetaDataDeletionService } from './meta-data-deletion.service';
import { MetaDeauthorizeService } from './meta-deauthorize.service';
import { MetaPrivacyController } from './meta-privacy.controller';
import { MetaSignedRequestVerifier } from './meta-signed-request-verifier.service';

const SECRET = 'controller-spec-secret';
const CODE = 'a'.repeat(32);

function sign(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${sig}.${encoded}`;
}

const VALID = sign({
  algorithm: 'HMAC-SHA256',
  issued_at: 1_790_000_000,
  user_id: '1234567890',
});

describe('MetaPrivacyController', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;
  const config = {
    metaAppSecret: SECRET,
    apiPublicBaseUrl: 'https://api.example.com/',
  };
  const deletion = {
    request: jest.fn(),
    status: jest.fn(),
  };
  const deauthorize = { handle: jest.fn() };
  const rateLimiter = { allow: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MetaPrivacyController],
      providers: [
        MetaSignedRequestVerifier,
        { provide: AppConfigService, useValue: config },
        {
          provide: AppLoggerService,
          useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        { provide: MetaDataDeletionService, useValue: deletion },
        { provide: MetaDeauthorizeService, useValue: deauthorize },
        { provide: WebhookRateLimiterService, useValue: rateLimiter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config.metaAppSecret = SECRET;
    config.apiPublicBaseUrl = 'https://api.example.com/';
    deletion.request.mockResolvedValue({
      confirmationCode: CODE,
      status: 'completed',
    });
    deauthorize.handle.mockResolvedValue({ socialChannelsDegraded: 1 });
    rateLimiter.allow.mockResolvedValue(true);
  });

  describe('POST /meta/data-deletion', () => {
    it("answers a form-encoded signed_request with Meta's { url, confirmation_code } shape", async () => {
      const res = await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({ signed_request: VALID })
        .expect(200);

      expect(res.body).toEqual({
        url: `https://api.example.com/meta/data-deletion/status/${CODE}`,
        confirmation_code: CODE,
      });
      expect(deletion.request).toHaveBeenCalledWith(VALID, {
        userId: '1234567890',
        issuedAt: new Date(1_790_000_000 * 1000),
      });
    });

    it('accepts the same body as JSON', async () => {
      await request(server())
        .post('/meta/data-deletion')
        .send({ signed_request: VALID })
        .expect(200);
    });

    it('401s a request signed with another secret and deletes nothing', async () => {
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({
          signed_request: sign(
            { algorithm: 'HMAC-SHA256', user_id: '1' },
            'wrong',
          ),
        })
        .expect(401);
      expect(deletion.request).not.toHaveBeenCalled();
    });

    it('401s a correctly signed payload with the wrong algorithm', async () => {
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({ signed_request: sign({ algorithm: 'none', user_id: '1' }) })
        .expect(401);
      expect(deletion.request).not.toHaveBeenCalled();
    });

    it('400s a malformed or missing signed_request', async () => {
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({ signed_request: 'no-dot-here' })
        .expect(400);
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({})
        .expect(400);
      expect(deletion.request).not.toHaveBeenCalled();
    });

    it('503s — before touching data — when no public base URL is configured', async () => {
      config.apiPublicBaseUrl = '';
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({ signed_request: VALID })
        .expect(503);
      expect(deletion.request).not.toHaveBeenCalled();
    });

    it('503s when no Meta app secret is configured', async () => {
      config.metaAppSecret = '';
      await request(server())
        .post('/meta/data-deletion')
        .type('form')
        .send({ signed_request: VALID })
        .expect(503);
      expect(deletion.request).not.toHaveBeenCalled();
    });
  });

  describe('GET /meta/data-deletion/status/:code', () => {
    const status = {
      confirmationCode: CODE,
      status: 'completed' as const,
      requestedAt: new Date('2026-09-19T10:00:00Z'),
      completedAt: new Date('2026-09-19T10:00:01Z'),
    };

    it('returns status + timestamps only, as JSON when asked', async () => {
      deletion.status.mockResolvedValue(status);

      const res = await request(server())
        .get(`/meta/data-deletion/status/${CODE}`)
        .set('Accept', 'application/json')
        .expect(200);

      expect(res.body).toEqual({
        confirmation_code: CODE,
        status: 'completed',
        requested_at: '2026-09-19T10:00:00.000Z',
        completed_at: '2026-09-19T10:00:01.000Z',
      });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('renders a human-readable HTML page for a browser', async () => {
      deletion.status.mockResolvedValue(status);

      const res = await request(server())
        .get(`/meta/data-deletion/status/${CODE}`)
        .set('Accept', 'text/html')
        .expect(200);

      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('completed');
      expect(res.text).toContain(CODE);
    });

    it('404s an unknown code', async () => {
      deletion.status.mockResolvedValue(null);
      await request(server())
        .get(`/meta/data-deletion/status/${'b'.repeat(32)}`)
        .expect(404);
    });

    it('429s once the per-client budget is spent, without a lookup', async () => {
      rateLimiter.allow.mockResolvedValue(false);
      await request(server())
        .get(`/meta/data-deletion/status/${CODE}`)
        .expect(429);
      expect(deletion.status).not.toHaveBeenCalled();
    });
  });

  describe('POST /meta/deauthorize', () => {
    it('verifies, hands the user to the deauthorize service, and reveals nothing', async () => {
      const res = await request(server())
        .post('/meta/deauthorize')
        .type('form')
        .send({ signed_request: VALID })
        .expect(200);

      expect(res.body).toEqual({ received: true });
      expect(deauthorize.handle).toHaveBeenCalledWith({
        userId: '1234567890',
        issuedAt: new Date(1_790_000_000 * 1000),
      });
    });

    it('401s a tampered request and degrades nothing', async () => {
      const [sig] = VALID.split('.');
      const forged = Buffer.from(
        JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '999' }),
      ).toString('base64url');

      await request(server())
        .post('/meta/deauthorize')
        .type('form')
        .send({ signed_request: `${sig}.${forged}` })
        .expect(401);
      expect(deauthorize.handle).not.toHaveBeenCalled();
    });
  });
});
