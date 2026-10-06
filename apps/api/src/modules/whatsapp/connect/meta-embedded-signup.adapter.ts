// Channel/connect (WhatsappModule, Gulf T3 / D3): EmbeddedSignupPort over the
// shared MetaGraphClient. All Graph I/O goes through that client (D8); this
// file only knows the endpoints and turns Meta's error codes into the
// EmbeddedSignupFailure vocabulary ConnectService branches on.
//
// Endpoints (Meta, "Onboarding business customers as a Tech Provider",
// verified 2026-09-19):
//   GET  /oauth/access_token?client_id&client_secret&code
//   GET  /debug_token (granular_scopes)
//   GET  /{waba-id}/phone_numbers
//   POST /{waba-id}/subscribed_apps
//   POST /{phone-number-id}/register {messaging_product: whatsapp, pin}
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core';
import {
  MetaGraphClient,
  type GraphTokenScopes,
} from '../../meta-graph/meta-graph.client';
import { MetaGraphError } from '../../meta-graph/meta-graph.error';
import {
  EmbeddedSignupError,
  EmbeddedSignupPort,
  type EmbeddedSignupFailure,
  type EmbeddedSignupGrant,
  type EmbeddedSignupPhoneNumber,
} from './ports/embedded-signup.port';

const MANAGEMENT_SCOPE = 'whatsapp_business_management';
const MESSAGING_SCOPE = 'whatsapp_business_messaging';

/** Meta Cloud API registration error codes (Cloud API "Error codes" reference). */
const PIN_MISMATCH_CODES = new Set([133005]);
const PIN_LOCKED_CODES = new Set([133008, 133009, 133016]);

/** Far above any real WABA; one page keeps this a single request. */
const PHONE_NUMBER_PAGE_LIMIT = '100';

@Injectable()
export class MetaEmbeddedSignupAdapter extends EmbeddedSignupPort {
  constructor(
    private readonly graph: MetaGraphClient,
    private readonly config: AppConfigService,
  ) {
    super();
  }

  async exchangeCode(code: string): Promise<string> {
    try {
      const { accessToken } = await this.graph.exchangeEmbeddedSignupCode(code);
      return accessToken;
    } catch (error) {
      throw this.translate(
        error,
        'Embedded Signup code exchange',
        (graphError) =>
          graphError.status >= 400 && graphError.status < 500
            ? 'invalid_code'
            : 'upstream',
      );
    }
  }

  async inspectGrant(accessToken: string): Promise<EmbeddedSignupGrant> {
    let scopes: GraphTokenScopes;
    try {
      scopes = await this.graph.inspectTokenScopes(accessToken);
    } catch (error) {
      throw this.translate(error, 'Business token inspection');
    }
    const targetsFor = (scope: string): string[] =>
      scopes.granularScopes
        .filter((entry) => entry.scope === scope)
        .flatMap((entry) => entry.targetIds);

    return {
      // A token issued to another app would still debug as valid; only a
      // token minted for OUR app proves the tenant ran OUR signup flow.
      valid: scopes.valid && scopes.appId === this.config.metaAppId,
      managementWabaIds: targetsFor(MANAGEMENT_SCOPE),
      messagingWabaIds: targetsFor(MESSAGING_SCOPE),
      metaUserId: scopes.userId,
    };
  }

  async listPhoneNumbers(
    wabaId: string,
    accessToken: string,
  ): Promise<EmbeddedSignupPhoneNumber[]> {
    let payload: unknown;
    try {
      payload = await this.graph.get(`${wabaId}/phone_numbers`, accessToken, {
        fields: 'id,display_phone_number,verified_name,is_on_biz_app',
        limit: PHONE_NUMBER_PAGE_LIMIT,
      });
    } catch (error) {
      throw this.translate(error, 'Phone number lookup');
    }
    const data = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return [];

    return data.flatMap((row: unknown) => {
      const entry = row as Record<string, unknown> | null;
      if (!entry || typeof entry.id !== 'string') return [];
      return [
        {
          id: entry.id,
          displayPhoneNumber:
            typeof entry.display_phone_number === 'string'
              ? entry.display_phone_number
              : null,
          isOnBizApp: entry.is_on_biz_app === true,
        },
      ];
    });
  }

  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    try {
      await this.graph.post(`${wabaId}/subscribed_apps`, {}, accessToken);
    } catch (error) {
      throw this.translate(error, 'Webhook subscription');
    }
  }

  async registerPhoneNumber(
    phoneNumberId: string,
    pin: string,
    accessToken: string,
  ): Promise<void> {
    try {
      await this.graph.post(
        `${phoneNumberId}/register`,
        { messaging_product: 'whatsapp', pin },
        accessToken,
      );
    } catch (error) {
      throw this.translate(error, 'Phone number registration', (graphError) => {
        if (graphError.code !== null && PIN_MISMATCH_CODES.has(graphError.code))
          return 'pin_mismatch';
        if (graphError.code !== null && PIN_LOCKED_CODES.has(graphError.code))
          return 'pin_locked';
        return 'upstream';
      });
    }
  }

  /** MetaGraphError → EmbeddedSignupError. Anything else (timeouts, bugs) propagates untouched. */
  private translate(
    error: unknown,
    operation: string,
    classify: (error: MetaGraphError) => EmbeddedSignupFailure = () =>
      'upstream',
  ): unknown {
    if (!(error instanceof MetaGraphError)) return error;
    // The client already redacted every token/secret/code it sent.
    return new EmbeddedSignupError(
      classify(error),
      error.withOperation(operation).message,
    );
  }
}
