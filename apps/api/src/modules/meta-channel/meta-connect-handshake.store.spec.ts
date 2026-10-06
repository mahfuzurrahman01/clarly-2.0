// Gulf T4 (D4): the short-lived, server-side record that carries Meta's own
// page list (and tokens) from step A to step B of the social connect flow.
// A fake Redis (a Map with TTLs) and the REAL AES-GCM cipher, so the
// "tokens are encrypted at rest" assertion is about the real ciphertext.
import type Redis from 'ioredis';
import type { AppConfigService, Clock } from '../core';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';
import {
  META_CONNECT_HANDSHAKE_TTL_SECONDS,
  MetaConnectHandshakeStore,
  type MetaConnectHandshake,
} from './meta-connect-handshake.store';

const NOW = new Date('2026-09-19T10:00:00Z');

function fakeRedis() {
  const values = new Map<string, { value: string; ttl: number }>();
  const redis = {
    set: jest.fn((key: string, value: string, mode: string, ttl: number) => {
      expect(mode).toBe('EX');
      values.set(key, { value, ttl });
      return Promise.resolve('OK');
    }),
    get: jest.fn((key: string) =>
      Promise.resolve(values.get(key)?.value ?? null),
    ),
  };
  return { redis, values };
}

function handshake(
  overrides: Partial<MetaConnectHandshake> = {},
): MetaConnectHandshake {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    metaUserId: '1234567890',
    userAccessToken: 'LONG_LIVED_USER_TOKEN',
    pages: [
      {
        id: 'PAGE_1',
        name: 'Shop One',
        accessToken: 'PAGE_TOKEN_1',
        instagram: { id: 'IG_1', username: 'shop.one' },
      },
    ],
    ...overrides,
  };
}

describe('MetaConnectHandshakeStore', () => {
  const encryption = new BspCredentialsEncryptionService({
    bspCredentialsEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
  } as unknown as AppConfigService);
  const clock: Clock = { now: () => NOW, nowMs: () => NOW.getTime() };

  it('stores the handshake encrypted under an unguessable id with a TTL', async () => {
    const { redis, values } = fakeRedis();
    const store = new MetaConnectHandshakeStore(
      redis as unknown as Redis,
      encryption,
      clock,
    );

    const saved = await store.save(handshake());

    expect(saved.handshakeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.expiresAt).toEqual(
      new Date(NOW.getTime() + META_CONNECT_HANDSHAKE_TTL_SECONDS * 1000),
    );
    const [[key, stored]] = [...values.entries()];
    expect(key).toBe(`meta-connect:handshake:${saved.handshakeId}`);
    expect(stored.ttl).toBe(META_CONNECT_HANDSHAKE_TTL_SECONDS);
    // Tokens never sit in Redis in the clear.
    expect(stored.value).not.toContain('LONG_LIVED_USER_TOKEN');
    expect(stored.value).not.toContain('PAGE_TOKEN_1');
  });

  it('round-trips for the same tenant and user', async () => {
    const { redis } = fakeRedis();
    const store = new MetaConnectHandshakeStore(
      redis as unknown as Redis,
      encryption,
      clock,
    );
    const { handshakeId } = await store.save(handshake());

    await expect(
      store.load(handshakeId, { tenantId: 'tenant-a', userId: 'user-a' }),
    ).resolves.toEqual(handshake());
  });

  it.each([
    ['another tenant', { tenantId: 'tenant-b', userId: 'user-a' }],
    [
      'another user in the same tenant',
      { tenantId: 'tenant-a', userId: 'user-b' },
    ],
  ])('returns null for %s', async (_label, owner) => {
    const { redis } = fakeRedis();
    const store = new MetaConnectHandshakeStore(
      redis as unknown as Redis,
      encryption,
      clock,
    );
    const { handshakeId } = await store.save(handshake());

    await expect(store.load(handshakeId, owner)).resolves.toBeNull();
  });

  it('returns null for an unknown or expired id', async () => {
    const { redis } = fakeRedis();
    const store = new MetaConnectHandshakeStore(
      redis as unknown as Redis,
      encryption,
      clock,
    );

    await expect(
      store.load('x'.repeat(43), { tenantId: 'tenant-a', userId: 'user-a' }),
    ).resolves.toBeNull();
  });

  it('returns null rather than throwing for a value that fails to decrypt', async () => {
    const { redis, values } = fakeRedis();
    const store = new MetaConnectHandshakeStore(
      redis as unknown as Redis,
      encryption,
      clock,
    );
    const { handshakeId } = await store.save(handshake());
    const key = `meta-connect:handshake:${handshakeId}`;
    values.set(key, { value: 'dGFtcGVyZWQ=', ttl: 1 });

    await expect(
      store.load(handshakeId, { tenantId: 'tenant-a', userId: 'user-a' }),
    ).resolves.toBeNull();
  });
});
