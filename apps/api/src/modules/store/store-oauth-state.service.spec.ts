// F24: the OAuth-state tests are the CSRF regression tests — the first cut
// had no state verification at all and read the tenant from `?tenant_id=`.
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import type { AppConfigService } from '../core';
import {
  InvalidStoreConnectStateError,
  StoreOAuthStateService,
} from './store-oauth-state.service';

const SECRET = 'store-state-test-secret';

function makeRedis(): Redis {
  const store = new Map<string, string>();
  const set = jest.fn(
    async (
      key: string,
      value: string,
      _ex: 'EX',
      _ttl: number,
      _nx: 'NX',
    ): Promise<'OK' | null> => {
      if (store.has(key)) {
        return null;
      }
      store.set(key, value);
      return 'OK';
    },
  );
  return { set } as unknown as Redis;
}

function makeService(
  secret: string = SECRET,
  redis: Redis = makeRedis(),
): StoreOAuthStateService {
  return new StoreOAuthStateService(
    { whatsappConnectStateSecret: secret } as unknown as AppConfigService,
    redis,
  );
}

describe('StoreOAuthStateService', () => {
  it('round-trips the tenant and provider it was signed with', async () => {
    const service = makeService();
    const state = service.sign('tenant-1', 'salla');

    await expect(service.verify(state, 'salla')).resolves.toEqual({
      tenantId: 'tenant-1',
      provider: 'salla',
    });
  });

  it('rejects a missing state', async () => {
    await expect(makeService().verify(undefined, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects a state signed with a different secret (forgery)', async () => {
    const forged = jwt.sign(
      { tenantId: 'victim-tenant', provider: 'salla' },
      'attacker-key',
      {
        algorithm: 'HS256',
        audience: 'store-connect',
        expiresIn: 600,
      },
    );

    await expect(makeService().verify(forged, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects an unsigned (alg=none) state', async () => {
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ tenantId: 'victim-tenant', provider: 'salla' }),
    ).toString('base64url')}.`;

    await expect(makeService().verify(unsigned, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects an expired state', async () => {
    const expired = jwt.sign(
      { tenantId: 'tenant-1', provider: 'salla' },
      SECRET,
      {
        algorithm: 'HS256',
        audience: 'store-connect',
        expiresIn: -10,
      },
    );

    await expect(makeService().verify(expired, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects a state minted for a different provider (cross-flow replay)', async () => {
    const service = makeService();
    const sallaState = service.sign('tenant-1', 'salla');

    await expect(service.verify(sallaState, 'shopify')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects a WhatsApp connect state replayed into the store flow (wrong audience)', async () => {
    const whatsappState = jwt.sign(
      { tenantId: 'tenant-1', provider: 'salla' },
      SECRET,
      {
        algorithm: 'HS256',
        expiresIn: 600,
      },
    );

    await expect(
      makeService().verify(whatsappState, 'salla'),
    ).rejects.toThrow(InvalidStoreConnectStateError);
  });

  it('refuses to sign or verify when no state secret is configured (fails closed)', async () => {
    const service = makeService('');

    expect(() => service.sign('tenant-1', 'salla')).toThrow(
      InvalidStoreConnectStateError,
    );
    await expect(service.verify('anything', 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('rejects the same state string verified a second time (replay)', async () => {
    const redis = makeRedis();
    const service = makeService(SECRET, redis);
    const state = service.sign('tenant-1', 'salla');

    await expect(service.verify(state, 'salla')).resolves.toEqual({
      tenantId: 'tenant-1',
      provider: 'salla',
    });
    await expect(service.verify(state, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });

  it('allows two different states (different jti) to each verify once', async () => {
    const redis = makeRedis();
    const service = makeService(SECRET, redis);
    const stateA = service.sign('tenant-1', 'salla');
    const stateB = service.sign('tenant-1', 'salla');

    await expect(service.verify(stateA, 'salla')).resolves.toEqual({
      tenantId: 'tenant-1',
      provider: 'salla',
    });
    await expect(service.verify(stateB, 'salla')).resolves.toEqual({
      tenantId: 'tenant-1',
      provider: 'salla',
    });
  });

  it('fails closed when Redis errors while claiming the nonce', async () => {
    const redis = {
      set: jest.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as Redis;
    const service = makeService(SECRET, redis);
    const state = service.sign('tenant-1', 'salla');

    await expect(service.verify(state, 'salla')).rejects.toThrow(
      InvalidStoreConnectStateError,
    );
  });
});
