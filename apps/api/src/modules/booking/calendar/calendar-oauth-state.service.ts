// Clarly 2.0 S2: the signed, single-use `state` for the Google Calendar
// connect flow. Same construction as StoreOAuthStateService (HS256 JWT signed
// with WHATSAPP_CONNECT_STATE_SECRET, 10-minute expiry, `jti` claimed once in
// Redis), with its own audience so a store state can never complete a
// calendar connect or the reverse.
import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import { AppConfigService } from '../../core';
import { QUEUE_REDIS_CONNECTION } from '../../queue/queue.providers';

const STATE_TTL_SECONDS = 600;
const STATE_AUDIENCE = 'calendar-connect';
const NONCE_KEY_PREFIX = 'calendar-connect-state:jti:';

export interface CalendarConnectState {
  tenantId: string;
  userId: string;
  nonce: string;
}

export class InvalidCalendarStateError extends Error {
  constructor(cause?: unknown) {
    super('Calendar connect state is missing, expired, reused or invalid.');
    this.name = 'InvalidCalendarStateError';
    this.cause = cause;
  }
}

@Injectable()
export class CalendarOAuthStateService {
  constructor(
    private readonly config: AppConfigService,
    @Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis,
  ) {}

  isConfigured(): boolean {
    return !!this.config.whatsappConnectStateSecret;
  }

  private get secret(): string {
    const secret = this.config.whatsappConnectStateSecret;
    if (!secret) {
      throw new InvalidCalendarStateError(
        new Error('WHATSAPP_CONNECT_STATE_SECRET is not configured.'),
      );
    }
    return secret;
  }

  sign(tenantId: string, userId: string): string {
    return jwt.sign({ tenantId, userId, jti: randomUUID() }, this.secret, {
      algorithm: 'HS256',
      audience: STATE_AUDIENCE,
      expiresIn: STATE_TTL_SECONDS,
    });
  }

  async verify(state: string | undefined): Promise<CalendarConnectState> {
    if (!state) throw new InvalidCalendarStateError();
    let payload: jwt.JwtPayload | string;
    try {
      payload = jwt.verify(state, this.secret, {
        algorithms: ['HS256'],
        audience: STATE_AUDIENCE,
      });
    } catch (error) {
      throw new InvalidCalendarStateError(error);
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new InvalidCalendarStateError();
    }
    const { tenantId, userId, jti, exp } = payload as Record<string, unknown>;
    if (
      typeof tenantId !== 'string' ||
      typeof userId !== 'string' ||
      typeof jti !== 'string'
    ) {
      throw new InvalidCalendarStateError();
    }
    const ttl =
      typeof exp === 'number'
        ? Math.max(1, exp - Math.floor(Date.now() / 1000))
        : STATE_TTL_SECONDS;
    const claimed = await this.redis.set(
      `${NONCE_KEY_PREFIX}${jti}`,
      '1',
      'EX',
      ttl,
      'NX',
    );
    if (claimed !== 'OK') throw new InvalidCalendarStateError();
    return { tenantId, userId, nonce: jti };
  }
}
