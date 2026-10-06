// Channel/connect (WhatsappModule): the WhatsApp connect flow. Since D14
// Meta Cloud API is the only provider, and since Gulf T3 (D3) tenants
// connect their own WABA through our Meta app's Embedded Signup.
//
// completeEmbeddedSignup() owns the ORDER and every trust decision:
//   1. exchange the popup's single-use code for a business token;
//   2. debug_token: the browser-reported wabaId must be one the token was
//      granted on (management AND messaging), for OUR app;
//   3. the phoneNumberId must be a number on that WABA;
//   4. refuse a number another tenant holds BEFORE any Graph write;
//   5. subscribe our app to the WABA's webhooks;
//   6. register the number with a two-step PIN (D15c), unless it is a
//      WhatsApp Business app (coexistence, D13) number, which is already
//      registered and must not be;
//   7. store {accessToken, wabaId, pin} encrypted via connectNumber (keeps
//      the ON CONFLICT cross-tenant hijack guard).
// Steps 1-5 failing store nothing and return 4xx/5xx. Once the WABA is
// subscribed, a failed register still stores the row, as
// `reconnect_required` with an actionable reason, never `active`.
//
// D16: no card-before-connect gate. A trialing tenant connects; AI replies
// stay behind the respond-path entitlement gate.
//
// Depends only on ports and this module's own services, never a vendor
// class. Tokens and PINs are never logged.
import { randomInt } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AppLoggerService } from '../../core';
import { WhatsappNumberDirectory } from '../whatsapp-number-directory.service';
import type {
  ConnectedNumber,
  EmbeddedSignupBody,
  EmbeddedSignupResult,
} from './connect.dto';
import { normalizeDisplayPhoneNumber } from '../health/waba-health-webhook.parser';
import {
  EmbeddedSignupError,
  EmbeddedSignupPort,
  type EmbeddedSignupGrant,
  type EmbeddedSignupPhoneNumber,
} from './ports/embedded-signup.port';
import {
  ChannelOwnedByAnotherTenantError,
  WhatsappConnectionService,
  type ConnectedNumberProfile,
  type ConnectionStatus,
} from './whatsapp-connection.service';

const CONTEXT = 'ConnectService';

const ACTIVE_STATUS: ConnectionStatus = {
  connectionState: 'active',
  connectionError: null,
};

/** Tenant-facing reasons, stored as `connection_error`. */
export const REGISTER_FAILURE_MESSAGES = {
  pin_mismatch:
    'This number already has a two-step verification PIN. Turn off two-step verification for it in WhatsApp Manager, or enter its current 6-digit PIN, then connect again.',
  pin_locked:
    'Meta has paused PIN attempts for this number after too many tries. Wait a while, then connect again.',
  upstream:
    'Meta did not finish registering this number. Connect it again; if it keeps failing, check the number in WhatsApp Manager.',
} as const;

interface RegisterOutcome {
  status: ConnectionStatus;
  /** The PIN to store: only one Meta may now hold for this number. */
  pin: string | null;
}

@Injectable()
export class ConnectService {
  constructor(
    private readonly directory: WhatsappNumberDirectory,
    private readonly connection: WhatsappConnectionService,
    private readonly embeddedSignup: EmbeddedSignupPort,
    private readonly logger: AppLoggerService,
  ) {}

  async listNumbers(tenantId: string): Promise<ConnectedNumber[]> {
    return this.directory.listForTenant(tenantId);
  }

  async completeEmbeddedSignup(
    tenantId: string,
    input: EmbeddedSignupBody,
  ): Promise<EmbeddedSignupResult> {
    const accessToken = await this.exchangeCode(input.code);
    const grant = await this.assertWabaGranted(accessToken, input.wabaId);
    const number = await this.resolveNumber(
      accessToken,
      input.wabaId,
      input.phoneNumberId,
    );

    if (await this.connection.isConnectedToAnotherTenant(tenantId, number.id)) {
      throw alreadyConnected();
    }

    await this.graphStep(() =>
      this.embeddedSignup.subscribeApp(input.wabaId, accessToken),
    );

    const outcome = number.isOnBizApp
      ? { status: ACTIVE_STATUS, pin: null }
      : await this.register(tenantId, number.id, accessToken, input.pin);

    const stored = await this.store(
      tenantId,
      number.id,
      outcome,
      { accessToken, wabaId: input.wabaId },
      {
        wabaId: input.wabaId,
        displayPhoneNumber: number.displayPhoneNumber
          ? normalizeDisplayPhoneNumber(number.displayPhoneNumber) || null
          : null,
        connectedByMetaUserId: grant.metaUserId,
      },
    );
    this.logger.log(
      `embedded signup stored tenant=${tenantId} waba=${input.wabaId} phone_number_id=${number.id} state=${stored.connectionState} coexistence=${number.isOnBizApp}`,
      CONTEXT,
    );
    return { ...stored, coexistence: number.isOnBizApp };
  }

  private async exchangeCode(code: string): Promise<string> {
    try {
      return await this.embeddedSignup.exchangeCode(code);
    } catch (error) {
      const failure = toSignupError(error);
      if (failure.failure === 'invalid_code') {
        throw new BadRequestException(
          'The WhatsApp signup code was already used or has expired. Run the WhatsApp signup again.',
        );
      }
      throw this.badGateway(failure);
    }
  }

  private async assertWabaGranted(
    accessToken: string,
    wabaId: string,
  ): Promise<EmbeddedSignupGrant> {
    const grant = await this.graphStep(() =>
      this.embeddedSignup.inspectGrant(accessToken),
    );
    if (
      !grant.valid ||
      !grant.managementWabaIds.includes(wabaId) ||
      !grant.messagingWabaIds.includes(wabaId)
    ) {
      throw new ForbiddenException(
        'This WhatsApp Business account was not shared with us in this signup.',
      );
    }
    return grant;
  }

  private async resolveNumber(
    accessToken: string,
    wabaId: string,
    phoneNumberId: string | undefined,
  ): Promise<EmbeddedSignupPhoneNumber> {
    const numbers = await this.graphStep(() =>
      this.embeddedSignup.listPhoneNumbers(wabaId, accessToken),
    );
    if (phoneNumberId === undefined) {
      if (numbers.length !== 1) {
        throw new BadRequestException(
          'phoneNumberId is required: this WhatsApp Business account does not have exactly one phone number.',
        );
      }
      return numbers[0];
    }
    const number = numbers.find((candidate) => candidate.id === phoneNumberId);
    if (!number) {
      throw new ForbiddenException(
        'This phone number does not belong to the WhatsApp Business account shared in this signup.',
      );
    }
    return number;
  }

  /**
   * D15c. PIN precedence: the tenant's own (existing-PIN path) > the one we
   * stored on an earlier attempt > a fresh server-generated one. Every
   * failure maps to `reconnect_required` with a reason the admin can act on.
   */
  private async register(
    tenantId: string,
    phoneNumberId: string,
    accessToken: string,
    tenantPin: string | undefined,
  ): Promise<RegisterOutcome> {
    const pin =
      tenantPin ??
      (await this.connection.getStoredPin(tenantId, phoneNumberId)) ??
      generatePin();
    try {
      await this.embeddedSignup.registerPhoneNumber(
        phoneNumberId,
        pin,
        accessToken,
      );
      return { status: ACTIVE_STATUS, pin };
    } catch (error) {
      const { failure, message } = toSignupError(error);
      this.logger.warn(
        `embedded signup register failed tenant=${tenantId} phone_number_id=${phoneNumberId} failure=${failure}: ${message}`,
        CONTEXT,
      );
      return {
        status: {
          connectionState: 'reconnect_required',
          connectionError:
            REGISTER_FAILURE_MESSAGES[
              failure === 'invalid_code' ? 'upstream' : failure
            ],
        },
        // A mismatch/lock proves Meta holds some OTHER PIN. After an
        // unexplained failure the PIN may have been applied, so keep it for
        // the retry.
        pin: failure === 'upstream' ? pin : null,
      };
    }
  }

  private async store(
    tenantId: string,
    phoneNumberId: string,
    outcome: RegisterOutcome,
    credentials: { accessToken: string; wabaId: string },
    profile: ConnectedNumberProfile,
  ) {
    try {
      return await this.connection.connectNumber(
        tenantId,
        phoneNumberId,
        { ...credentials, pin: outcome.pin },
        outcome.status,
        profile,
      );
    } catch (error) {
      if (error instanceof ChannelOwnedByAnotherTenantError) {
        throw alreadyConnected();
      }
      throw error;
    }
  }

  /** A Graph read/write that must succeed before anything is stored. */
  private async graphStep<T>(step: () => Promise<T>): Promise<T> {
    try {
      return await step();
    } catch (error) {
      throw this.badGateway(toSignupError(error));
    }
  }

  private badGateway(error: EmbeddedSignupError): BadGatewayException {
    this.logger.warn(
      `embedded signup Graph step failed: ${error.message}`,
      CONTEXT,
    );
    return new BadGatewayException(
      'Meta could not complete the WhatsApp signup. Nothing was connected; try again.',
    );
  }
}

/** D15c: server-generated, uniformly random 6-digit two-step verification PIN. */
export function generatePin(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Same wording as the social connect 409: never names the owning workspace. */
function alreadyConnected(): ConflictException {
  return new ConflictException(
    'This WhatsApp number is already connected to another workspace.',
  );
}

/** Timeouts and network errors from the Graph client count as upstream failures; anything else is a bug and propagates. */
function toSignupError(error: unknown): EmbeddedSignupError {
  if (error instanceof EmbeddedSignupError) return error;
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      error instanceof TypeError)
  ) {
    return new EmbeddedSignupError(
      'upstream',
      `${error.name}: ${error.message}`,
    );
  }
  throw error;
}
