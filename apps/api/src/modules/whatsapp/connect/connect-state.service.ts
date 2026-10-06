// Channel/connect (WhatsappModule): signs and verifies the `state` value a
// connect flow round-trips through the provider (T3's Meta Embedded Signup
// is the consumer after D14).
//
// CSRF-safety: the state is an HMAC-signed (HS256) JWT this API issues to
// itself — a caller cannot forge one without WHATSAPP_CONNECT_STATE_SECRET,
// so a third party cannot trick an already-authenticated tenant's browser
// into completing a connect flow that gets attributed to a DIFFERENT
// tenant (the classic OAuth-state CSRF). Tenant-bound: the tenantId is
// inside the signed payload, never taken from any other part of the
// completing request (same discipline TenantDirectoryService documents for
// `auth.tenantId`).
//
// SCOPED LIMITATION, stated rather than hidden: this is expiry-bound
// (10 minutes — long enough for a real connect flow, short enough to bound
// a leaked/logged value's blast radius) but not single-use. A true
// single-use nonce would need a shared store (Redis, already in this
// stack) keyed on jti with a delete-on-consume. Flagged here, not built
// quietly around.
import { Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../../core';

const STATE_TTL_SECONDS = 600;

export interface ConnectState {
  tenantId: string;
}

/** Thrown on an unsigned, expired, or tampered state param — the connect flow must reject rather than guess which tenant it belongs to. */
export class InvalidConnectStateError extends Error {
  constructor(cause?: unknown) {
    super('WhatsApp connect state is missing, expired, or invalid.');
    this.name = 'InvalidConnectStateError';
    this.cause = cause;
  }
}

@Injectable()
export class ConnectStateService {
  constructor(private readonly config: AppConfigService) {}

  sign(tenantId: string): string {
    return jwt.sign({ tenantId }, this.config.whatsappConnectStateSecret, {
      algorithm: 'HS256',
      expiresIn: STATE_TTL_SECONDS,
    });
  }

  verify(state: string | undefined): ConnectState {
    if (!state) {
      throw new InvalidConnectStateError();
    }
    try {
      const payload = jwt.verify(
        state,
        this.config.whatsappConnectStateSecret,
        { algorithms: ['HS256'] },
      );
      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { tenantId?: unknown }).tenantId !== 'string'
      ) {
        throw new InvalidConnectStateError();
      }
      return { tenantId: (payload as { tenantId: string }).tenantId };
    } catch (error) {
      if (error instanceof InvalidConnectStateError) {
        throw error;
      }
      throw new InvalidConnectStateError(error);
    }
  }
}
