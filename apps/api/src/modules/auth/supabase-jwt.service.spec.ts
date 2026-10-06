import { UnauthorizedException } from '@nestjs/common';
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../core';
import { SupabaseJwtService } from './supabase-jwt.service';

// Only the *remote* key-set factory is mocked: the tests below feed it a real
// ES256 key set built with jose's own createLocalJWKSet, so signature
// verification itself is genuine — nothing but the network fetch is faked.
jest.mock('jose', () => ({
  ...jest.requireActual<typeof import('jose')>('jose'),
  createRemoteJWKSet: jest.fn(),
}));

const SECRET = 'test-jwt-secret';
const SUPABASE_URL = 'http://127.0.0.1:54321';

function makeService(): SupabaseJwtService {
  const config = {
    supabaseJwtSecret: SECRET,
    supabaseUrl: SUPABASE_URL,
  } as AppConfigService;
  return new SupabaseJwtService(config);
}

function signClaims(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
      exp: now + 3600,
      ...overrides,
    },
    SECRET,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

describe('SupabaseJwtService', () => {
  it('extracts userId/tenantId/role from a validly signed token', async () => {
    const service = makeService();
    const token = signClaims();

    const result = await service.verify(token);

    expect(result).toEqual({
      userId: 'user-123',
      tenantId: '11111111-1111-1111-1111-111111111111',
      role: 'authenticated',
    });
  });

  it('extracts appRole from app_metadata.app_role when present (T14)', async () => {
    const service = makeService();
    const token = signClaims({
      app_metadata: {
        tenant_id: '11111111-1111-1111-1111-111111111111',
        app_role: 'admin',
      },
    });

    expect((await service.verify(token)).appRole).toBe('admin');
  });

  it('leaves appRole undefined when app_metadata.app_role is absent (still passes basic auth, T14 role gate is a separate layer)', async () => {
    const service = makeService();
    const token = signClaims();

    expect((await service.verify(token)).appRole).toBeUndefined();
  });

  it('rejects a token with an app_role outside the admin/agent enum', async () => {
    const service = makeService();
    const token = signClaims({
      app_metadata: {
        tenant_id: '11111111-1111-1111-1111-111111111111',
        app_role: 'superuser',
      },
    });

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token signed with a different secret', async () => {
    const service = makeService();
    const token = jwt.sign(
      {
        sub: 'user-123',
        role: 'authenticated',
        app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
      },
      'wrong-secret',
      { algorithm: 'HS256' },
    );

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an expired token', async () => {
    const service = makeService();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: 'user-123',
        role: 'authenticated',
        app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
        exp: now - 10,
      },
      SECRET,
      { algorithm: 'HS256', noTimestamp: true },
    );

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token missing app_metadata.tenant_id (schema validation)', async () => {
    const service = makeService();
    const token = jwt.sign(
      { sub: 'user-123', role: 'authenticated', app_metadata: {} },
      SECRET,
      { algorithm: 'HS256' },
    );

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token where tenant_id lives only in user_metadata (wrong claim location)', async () => {
    const service = makeService();
    const token = jwt.sign(
      {
        sub: 'user-123',
        role: 'authenticated',
        app_metadata: {},
        user_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
      },
      SECRET,
      { algorithm: 'HS256' },
    );

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed token without leaking the specific failure reason', async () => {
    const service = makeService();

    try {
      await service.verify('not-a-jwt');
      throw new Error('expected verify() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as Error).message).toBe('Invalid or expired token');
    }
  });

  it('rejects an alg:none token (no signature check bypass)', async () => {
    const service = makeService();
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-123',
        role: 'authenticated',
        app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
      }),
    ).toString('base64url');
    const token = `${header}.${payload}.`;

    await expect(service.verify(token)).rejects.toThrow(UnauthorizedException);
  });
});

describe('SupabaseJwtService.verifyFreshSignup()', () => {
  it('extracts userId from a validly signed token with no tenant_id yet', async () => {
    const service = makeService();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ sub: 'user-123', exp: now + 3600 }, SECRET, {
      algorithm: 'HS256',
      noTimestamp: true,
    });

    await expect(service.verifyFreshSignup(token)).resolves.toEqual({
      userId: 'user-123',
    });
  });

  it('surfaces existingTenantId when the token already carries one (already-provisioned user)', async () => {
    const service = makeService();
    const token = signClaims();

    await expect(service.verifyFreshSignup(token)).resolves.toEqual({
      userId: 'user-123',
      existingTenantId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const service = makeService();
    const token = jwt.sign({ sub: 'user-123' }, 'wrong-secret', {
      algorithm: 'HS256',
    });

    await expect(service.verifyFreshSignup(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const service = makeService();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ sub: 'user-123', exp: now - 10 }, SECRET, {
      algorithm: 'HS256',
      noTimestamp: true,
    });

    await expect(service.verifyFreshSignup(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a token missing sub', async () => {
    const service = makeService();
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ exp: now + 3600 }, SECRET, {
      algorithm: 'HS256',
      noTimestamp: true,
    });

    await expect(service.verifyFreshSignup(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

// Current Supabase (and the local `supabase start` stack) signs access tokens
// with asymmetric keys, publishing the public half at the project's JWKS
// endpoint.
describe('SupabaseJwtService — asymmetric (ES256/JWKS) tokens', () => {
  const KID = 'test-signing-key';
  const mockedCreateRemoteJWKSet = jest.mocked(createRemoteJWKSet);

  beforeEach(() => {
    mockedCreateRemoteJWKSet.mockReset();
  });

  async function makeEs256Keys(): Promise<{
    privateKey: CryptoKey;
    jwk: JWK;
  }> {
    const { publicKey, privateKey } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const jwk: JWK = {
      ...(await exportJWK(publicKey)),
      kid: KID,
      alg: 'ES256',
    };
    return { privateKey: privateKey as CryptoKey, jwk };
  }

  function publishKeys(keys: JWK[]): void {
    mockedCreateRemoteJWKSet.mockReturnValue(
      createLocalJWKSet({ keys }) as unknown as ReturnType<
        typeof createRemoteJWKSet
      >,
    );
  }

  function signEs256(
    privateKey: CryptoKey,
    claims: Record<string, unknown>,
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setExpirationTime('1h')
      .sign(privateKey);
  }

  it('accepts an ES256 token whose signing key is published at the project JWKS endpoint', async () => {
    const { privateKey, jwk } = await makeEs256Keys();
    publishKeys([jwk]);
    const token = await signEs256(privateKey, {
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: {
        tenant_id: '11111111-1111-1111-1111-111111111111',
        app_role: 'admin',
      },
    });

    const result = await makeService().verify(token);

    expect(result).toEqual({
      userId: 'user-123',
      tenantId: '11111111-1111-1111-1111-111111111111',
      role: 'authenticated',
      appRole: 'admin',
    });
    expect(mockedCreateRemoteJWKSet.mock.calls[0][0].toString()).toBe(
      `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`,
    );
  });

  it('accepts an ES256 token on the fresh-signup path too', async () => {
    const { privateKey, jwk } = await makeEs256Keys();
    publishKeys([jwk]);
    const token = await signEs256(privateKey, { sub: 'user-123' });

    await expect(makeService().verifyFreshSignup(token)).resolves.toEqual({
      userId: 'user-123',
    });
  });

  it('rejects an ES256 token signed by a key the JWKS endpoint does not publish', async () => {
    const { privateKey } = await makeEs256Keys();
    const other = await makeEs256Keys();
    publishKeys([other.jwk]);
    const token = await signEs256(privateKey, {
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
    });

    await expect(makeService().verify(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired ES256 token', async () => {
    const { privateKey, jwk } = await makeEs256Keys();
    publishKeys([jwk]);
    const token = await new SignJWT({
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setExpirationTime('-1h')
      .sign(privateKey);

    await expect(makeService().verify(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects when the JWKS endpoint is unreachable', async () => {
    const { privateKey } = await makeEs256Keys();
    mockedCreateRemoteJWKSet.mockReturnValue((() =>
      Promise.reject(new Error('connection refused'))) as unknown as ReturnType<
      typeof createRemoteJWKSet
    >);
    const token = await signEs256(privateKey, {
      sub: 'user-123',
      role: 'authenticated',
      app_metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' },
    });

    await expect(makeService().verify(token)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('never consults the JWKS endpoint for an HS256 token (shared-secret path stays local)', async () => {
    publishKeys([]);

    await makeService().verify(signClaims());

    expect(mockedCreateRemoteJWKSet).not.toHaveBeenCalled();
  });
});
