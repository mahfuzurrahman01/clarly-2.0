// Channel (MetaChannelModule, Gulf T4 / D4): the server-side half of the
// two-step Messenger/Instagram connect.
//
// Step A (`POST /channels/meta/pages`) exchanges the browser's short-lived
// Facebook Login token and reads `/me/accounts`. What Meta returns there,
// including a page token per page, is the ONLY source of page tokens we
// trust. This store keeps that result for a few minutes so step B
// (`POST /channels/meta`) can pick a page from it without the browser ever
// seeing or re-sending a token.
//
// Why Redis and not a signed blob handed to the browser: the payload holds
// live tokens. Keeping it server-side means the client holds only an opaque,
// random id, and the tokens are gone when the TTL lapses.
//
// The value is encrypted with the same AES-GCM cipher as `social_channels`
// credentials (BspCredentialsEncryptionService), so a Redis dump or MONITOR
// never shows a token. The record is bound to the tenant AND the console
// user who started it; a load by anyone else reads as "not found".
import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { Clock } from '../core';
import type { GraphManagedPage } from '../meta-graph/meta-graph.module';
import { QUEUE_REDIS_CONNECTION } from '../queue/queue.providers';
import { BspCredentialsEncryptionService } from '../whatsapp/bsp-credentials-encryption.service';

/**
 * How long a tenant has between "logged in with Facebook" and "picked a
 * page". Long enough for a human to choose; short enough that an abandoned
 * handshake does not keep a live user token around.
 */
export const META_CONNECT_HANDSHAKE_TTL_SECONDS = 15 * 60;

const KEY_PREFIX = 'meta-connect:handshake:';

/** 32 random bytes, base64url: 43 characters, unguessable. */
const HANDSHAKE_ID_BYTES = 32;

export interface MetaConnectHandshake {
  tenantId: string;
  /** The console (Supabase) user who ran Facebook Login. */
  userId: string;
  /** The app-scoped Facebook user id from `/me`. */
  metaUserId: string;
  /** The LONG-LIVED user token (already exchanged). */
  userAccessToken: string;
  /** Meta's `/me/accounts` result, page tokens included. */
  pages: GraphManagedPage[];
}

export interface HandshakeOwner {
  tenantId: string;
  userId: string;
}

@Injectable()
export class MetaConnectHandshakeStore {
  constructor(
    @Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis,
    private readonly encryption: BspCredentialsEncryptionService,
    private readonly clock: Clock,
  ) {}

  async save(
    handshake: MetaConnectHandshake,
  ): Promise<{ handshakeId: string; expiresAt: Date }> {
    const handshakeId = randomBytes(HANDSHAKE_ID_BYTES).toString('base64url');
    const ciphertext = this.encryption.encrypt({ ...handshake });

    await this.redis.set(
      KEY_PREFIX + handshakeId,
      ciphertext,
      'EX',
      META_CONNECT_HANDSHAKE_TTL_SECONDS,
    );

    return {
      handshakeId,
      expiresAt: new Date(
        this.clock.nowMs() + META_CONNECT_HANDSHAKE_TTL_SECONDS * 1000,
      ),
    };
  }

  /**
   * The handshake, or null when it is unknown, expired, unreadable, or owned
   * by a different tenant or user. The caller cannot tell these apart, by
   * design.
   *
   * Not consumed on read: one Facebook Login may connect several pages from
   * the same picker within the TTL.
   */
  async load(
    handshakeId: string,
    owner: HandshakeOwner,
  ): Promise<MetaConnectHandshake | null> {
    const ciphertext = await this.redis.get(KEY_PREFIX + handshakeId);
    if (!ciphertext) return null;

    let handshake: MetaConnectHandshake;
    try {
      handshake = this.encryption.decrypt(
        ciphertext,
      ) as unknown as MetaConnectHandshake;
    } catch {
      // Tampered, or written under a rotated key. Either way the only fix is
      // a fresh login, which is what "not found" tells the caller.
      return null;
    }

    if (
      handshake.tenantId !== owner.tenantId ||
      handshake.userId !== owner.userId
    ) {
      return null;
    }
    return handshake;
  }
}
