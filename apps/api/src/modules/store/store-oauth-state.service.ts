// Feature 24 (Store Integrations): signs and verifies the `state` value a
// store connect flow round-trips through Salla/Zid/Shopify.
//
// This is deliberately the SAME mechanism as the WhatsApp connect flow's
// `ConnectStateService` (HMAC-signed HS256 JWT this API issues to itself),
// not a second invented one: the threat is identical — without a signed,
// tenant-bound state, the OAuth callback has to take the tenant from the
// request, and an attacker can then complete a connect flow that attaches
// THEIR store (or their token) to SOMEONE ELSE's workspace, or trick an
// authenticated admin's browser into attaching an attacker-controlled store
// to that admin's tenant (classic OAuth-state CSRF).
//
// Two differences from ConnectStateService, both deliberate:
//   - `aud: 'store-connect'` + a `provider` claim, so a state minted for one
//     flow/provider cannot be replayed into another (a WhatsApp connect state
//     is not a Salla connect state even though both are signed with the same
//     key).
//   - The secret is required, not optional: an unset
//     WHATSAPP_CONNECT_STATE_SECRET makes this throw at sign AND reject at
//     verify, so a deployment without it cannot connect stores at all rather
//     than connect them unsigned.
//
// Single-use enforcement: `sign()` mints a random `jti` and `verify()`
// claims it in Redis with `SET jti <marker> NX EX <ttl>` — one atomic
// round trip. NX means the second SET for the same jti fails, so a replayed
// state (same string submitted twice, e.g. a callback URL reused within the
// 10-minute window) fails closed on the second attempt instead of silently
// re-binding the tenant's store connection a second time. The key's TTL is
// clamped to the JWT's own remaining lifetime so it never outlives the token
// it guards, and a Redis outage rejects the state rather than skipping the
// single-use check — "can't verify single-use" must mean "reject", not
// "allow".
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import { AppConfigService } from '../core';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';
import type { StoreProviderName } from './store-provider-name';

const STATE_TTL_SECONDS = 600;
const STATE_AUDIENCE = 'store-connect';
const NONCE_KEY_PREFIX = 'store-connect-state:jti:';
const NONCE_MARKER = '1';

export interface StoreConnectState {
  tenantId: string;
  provider: StoreProviderName;
  /**
   * WooCommerce only. The merchant's own site, sealed in at initiate time by
   * the AUTHENTICATED admin who started the flow.
   *
   * It has to live here because WooCommerce's callback POST carries only the
   * new key pair and the echoed `user_id` — it never says which site sent it.
   * Taking the site from the callback request instead would re-create F24's
   * original hole in a new shape: an unauthenticated request choosing which
   * host a tenant's credentials belong to.
   */
  siteUrl?: string;
  /**
   * Shopify only. The `<name>.myshopify.com` host the authenticated admin
   * asked to connect. Shopify echoes `?shop=` on the callback, but that query
   * is unauthenticated input; the code is exchanged against THIS host.
   */
  shop?: string;
}

/** The merchant-side host a flow is pinned to, sealed into the state at initiate time. */
export type StoreConnectBinding = Pick<StoreConnectState, 'siteUrl' | 'shop'>;

/** Thrown on a missing, unsigned, expired, tampered, or provider-mismatched state param — the callback must reject rather than guess which tenant it belongs to. */
export class InvalidStoreConnectStateError extends Error {
  constructor(cause?: unknown) {
    super('Store connect state is missing, expired, or invalid.');
    this.name = 'InvalidStoreConnectStateError';
    this.cause = cause;
  }
}

@Injectable()
export class StoreOAuthStateService {
  constructor(
    private readonly config: AppConfigService,
    @Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  private get secret(): string {
    const secret = this.config.whatsappConnectStateSecret;
    if (!secret) {
      throw new InvalidStoreConnectStateError(
        new Error(
          'WHATSAPP_CONNECT_STATE_SECRET is not configured — refusing to sign or accept an unsigned store connect state.',
        ),
      );
    }
    return secret;
  }

  sign(
    tenantId: string,
    provider: StoreProviderName,
    binding: StoreConnectBinding = {},
  ): string {
    return jwt.sign(
      {
        tenantId,
        provider,
        siteUrl: binding.siteUrl,
        shop: binding.shop,
        jti: randomUUID(),
      },
      this.secret,
      {
        algorithm: 'HS256',
        audience: STATE_AUDIENCE,
        expiresIn: STATE_TTL_SECONDS,
      },
    );
  }

  /**
   * Verifies the state, claims its `jti` as single-use, and returns the
   * tenant it was minted for. `expectedProvider` is the provider the
   * callback route claims to be — a mismatch means a state is being
   * replayed across flows and is rejected.
   */
  async verify(
    state: string | undefined,
    expectedProvider: StoreProviderName,
  ): Promise<StoreConnectState> {
    if (!state) {
      throw new InvalidStoreConnectStateError();
    }
    try {
      const payload = jwt.verify(state, this.secret, {
        algorithms: ['HS256'],
        audience: STATE_AUDIENCE,
      });
      if (typeof payload !== 'object' || payload === null) {
        throw new InvalidStoreConnectStateError();
      }
      const { tenantId, provider, siteUrl, shop, jti, exp } = payload as {
        tenantId?: unknown;
        provider?: unknown;
        siteUrl?: unknown;
        shop?: unknown;
        jti?: unknown;
        exp?: unknown;
      };
      if (
        typeof tenantId !== 'string' ||
        typeof provider !== 'string' ||
        typeof jti !== 'string'
      ) {
        throw new InvalidStoreConnectStateError();
      }
      if (provider !== expectedProvider) {
        throw new InvalidStoreConnectStateError();
      }

      // Clamp to the JWT's own remaining lifetime (falling back to the full
      // TTL if `exp` is somehow absent) so the nonce key never outlives the
      // token it guards, and never lingers in Redis past that either.
      const remainingSeconds =
        typeof exp === 'number'
          ? Math.max(1, exp - Math.floor(Date.now() / 1000))
          : STATE_TTL_SECONDS;
      await this.claimNonce(jti, remainingSeconds);

      return {
        tenantId,
        provider: provider,
        siteUrl: typeof siteUrl === 'string' ? siteUrl : undefined,
        shop: typeof shop === 'string' ? shop : undefined,
      };
    } catch (error) {
      if (error instanceof InvalidStoreConnectStateError) {
        throw error;
      }
      throw new InvalidStoreConnectStateError(error);
    }
  }

  /**
   * Atomically claims `jti` as consumed. `SET ... NX` is a single round
   * trip: it succeeds only if the key does not already exist, so a second
   * claim for the same jti (a replayed state) fails closed rather than
   * racing a read-then-write. Any Redis error (including a timed-out/down
   * connection) is treated the same as a failed claim — see the file-level
   * comment for why this must fail closed.
   */
  private async claimNonce(jti: string, ttlSeconds: number): Promise<void> {
    let claimed: string | null;
    try {
      claimed = await this.redis.set(
        `${NONCE_KEY_PREFIX}${jti}`,
        NONCE_MARKER,
        'EX',
        ttlSeconds,
        'NX',
      );
    } catch (error) {
      throw new InvalidStoreConnectStateError(error);
    }
    if (claimed !== 'OK') {
      throw new InvalidStoreConnectStateError(
        new Error('Store connect state has already been used.'),
      );
    }
  }
}
