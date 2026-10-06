// Channel (WhatsappModule, T0): the Meta Cloud API BspAdapter binding —
// WhatsApp's first-party API, no BSP in the middle. Since D14 (Gulf T2)
// this is the ONLY WhatsApp provider (BSP_PROVIDER=meta); tenants connect
// their own WABA through our Meta app's Embedded Signup (T3).
//
// Everything specific to Meta's contract lives in this file, the shared
// Meta wire formats (meta-envelope.parser.ts) and the HMAC verification
// helper (webhook-signature.ts):
//
//   1. Inbound webhooks are signed `X-Hub-Signature-256: sha256=<hex>`,
//      keyed by the Meta APP SECRET (platform-level, one per Meta app).
//   2. Outbound sends authenticate with `Authorization: Bearer <token>`
//      against graph.facebook.com/{version}/{phone_number_id}/messages —
//      the phone number id is part of the PATH. All Graph I/O goes through
//      the shared MetaGraphClient (Gulf T1, D8), which owns the base URL,
//      version, timeout, bearer header and Meta's error envelope. Failures
//      surface as MetaGraphError, so `isTokenInvalid` (the code-190 family)
//      works on the send path exactly as it does on the social channels.
//   3. Meta requires a GET subscription handshake before it will register
//      a webhook at all.
//   4. Gulf T5 (D5): any call made with a number's token that Meta refuses
//      because the token is dead (401 / code 190) moves that number to
//      `reconnect_required` before the error propagates, so the console
//      shows a reconnect banner instead of replies failing silently. The
//      caller still gets the original error; retries/escalation unchanged.
import { Injectable } from '@nestjs/common';
import { AppConfigService, AppLoggerService } from '../core';
import {
  MetaGraphClient,
  MetaGraphError,
} from '../meta-graph/meta-graph.module';
import { BspCredentialsService } from './bsp-credentials.service';
import { CONNECTION_REASONS, degrade } from './health/connection-state.policy';
import { WhatsappNumberHealthStore } from './health/whatsapp-number-health.store';
import {
  parseMetaEnvelope,
  parseMetaMessageEchoes,
  parseMetaStatusUpdates,
  parseSentMessageId,
} from './meta-envelope.parser';
import { findSignatureHeader, verifyHmacSha256 } from './webhook-signature';
import { buildTemplatePayload } from './template-payload';
import {
  BspAdapter,
  type BspTemplateStatus,
  type BspTemplateSubmission,
  type InboundMedia,
  type NormalizedInboundMessage,
  type NormalizedMessageEcho,
  type NormalizedStatusUpdate,
  type SendTemplateMessageParams,
  type SendTextMessageParams,
  type SendTextMessageResult,
  type SubmitTemplateParams,
} from './ports/bsp-adapter.port';

const SIGNATURE_HEADER = 'x-hub-signature-256';

@Injectable()
export class MetaCloudAdapter extends BspAdapter {
  constructor(
    private readonly config: AppConfigService,
    private readonly credentials: BspCredentialsService,
    private readonly logger: AppLoggerService,
    private readonly graph: MetaGraphClient,
    private readonly health: WhatsappNumberHealthStore,
  ) {
    super();
  }

  /**
   * Meta signs with the app secret, NOT with any per-tenant credential —
   * one Meta app fronts every number it owns, so this is platform-level.
   */
  verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean {
    if (!this.config.bspWebhookSignatureRequired) {
      // Dev-only escape hatch; envSchema makes it unreachable under
      // NODE_ENV=production. Meta always signs, so there is no legitimate
      // reason to use it against real traffic — the warning says so.
      this.logger.warn(
        'MetaCloudAdapter: accepting an inbound webhook WITHOUT signature verification (BSP_WEBHOOK_SIGNATURE_REQUIRED=false). Meta always signs its webhooks, so this flag should not be set for this adapter.',
        MetaCloudAdapter.name,
      );
      return true;
    }

    return verifyHmacSha256(
      rawBody,
      findSignatureHeader(headers, SIGNATURE_HEADER),
      this.config.metaAppSecret,
    );
  }

  parseInboundWebhook(rawBody: string | Buffer): NormalizedInboundMessage[] {
    return parseMetaEnvelope(rawBody, MetaCloudAdapter.name);
  }

  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return parseMetaStatusUpdates(rawBody);
  }

  /** Gulf T3 (D13): WhatsApp Business app echoes on coexistence numbers. */
  parseMessageEchoes(rawBody: string | Buffer): NormalizedMessageEcho[] {
    return parseMetaMessageEchoes(rawBody);
  }

  /**
   * Meta's subscription handshake. Fails closed on a mismatched or absent
   * token, and on an unconfigured verify token — an attacker who could
   * pass this would only learn that the endpoint exists, but there is no
   * reason to concede even that.
   */
  verifySubscription(query: Record<string, string>): string | null {
    const verifyToken = this.config.metaVerifyToken;
    if (!verifyToken) {
      return null;
    }
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || token !== verifyToken || !challenge) {
      this.logger.warn(
        'MetaCloudAdapter: rejecting a webhook subscription handshake — mode or verify token did not match.',
        MetaCloudAdapter.name,
      );
      return null;
    }
    return challenge;
  }

  sendTextMessage(
    params: SendTextMessageParams,
  ): Promise<SendTextMessageResult> {
    return this.send(params.phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'text',
      text: { body: params.body },
    });
  }

  /**
   * F12: the only send that works outside the 24-hour window. Same endpoint
   * and same failure handling as a text send — only the payload differs, so
   * both go through `send()` rather than repeating the error contract.
   */
  sendTemplateMessage(
    params: SendTemplateMessageParams,
  ): Promise<SendTextMessageResult> {
    return this.send(params.phoneNumberId, buildTemplatePayload(params));
  }

  /**
   * Fetches inbound media (F13). Two hops, both authenticated with the same
   * per-number token:
   *
   *   1. `GET /{media_id}` returns a SHORT-LIVED signed `url` (minutes, and
   *      Meta does not document how many) — which is why the bytes are
   *      fetched immediately rather than the url being stored anywhere.
   *   2. `GET <url>` returns the bytes, and still requires the bearer token
   *      despite the url being signed. Omitting it 401s, which is the most
   *      common way this integration is got wrong.
   */
  async downloadMedia(
    phoneNumberId: string,
    mediaId: string,
  ): Promise<InboundMedia> {
    const accessToken = await this.credentials.getCredential(
      phoneNumberId,
      'accessToken',
    );

    const described = (await this.numberCall(
      phoneNumberId,
      this.graph.get(mediaId, accessToken),
      'MetaCloudAdapter: media lookup',
    )) as { url?: unknown; mime_type?: unknown } | null;
    if (typeof described?.url !== 'string') {
      throw new MetaGraphError(
        200,
        null,
        null,
        'MetaCloudAdapter: media lookup succeeded but carried no download url.',
      );
    }

    const content = await this.numberCall(
      phoneNumberId,
      this.graph.getBinary(described.url, accessToken),
      'MetaCloudAdapter: media download',
    );

    return {
      content,
      mimeType:
        typeof described.mime_type === 'string' ? described.mime_type : null,
    };
  }

  /**
   * Reconciles template review state against Meta's own listing.
   *
   * Needs `wabaId` alongside the access token in the stored credentials —
   * templates belong to the WhatsApp Business Account, not to a phone number.
   * Returns null when it is absent so an unreconcilable number leaves stored
   * statuses untouched rather than looking like an account with no templates.
   */
  async listTemplates(
    phoneNumberId: string,
  ): Promise<BspTemplateStatus[] | null> {
    let wabaId: string;
    let accessToken: string;
    try {
      wabaId = await this.credentials.getCredential(phoneNumberId, 'wabaId');
      accessToken = await this.credentials.getCredential(
        phoneNumberId,
        'accessToken',
      );
    } catch {
      this.logger.warn(
        `MetaCloudAdapter: cannot list templates for ${phoneNumberId} — no wabaId stored with its credentials.`,
        MetaCloudAdapter.name,
      );
      return null;
    }

    const listing = await this.numberCall(
      phoneNumberId,
      this.graph.get(`${wabaId}/message_templates`, accessToken, {
        limit: '200',
      }),
      'MetaCloudAdapter: template listing',
    );
    return parseTemplateListing(listing);
  }

  /**
   * Registers a template with the tenant's WhatsApp Business account
   * (`POST /{waba-id}/message_templates`) — the step that lets a template
   * ever reach `approved`, and with it the only way to message a customer
   * outside the 24-hour window.
   *
   * Note the id in the path: submission is a WABA-level operation, not a
   * phone-number-level one, same as `listTemplates` and unlike a send. The
   * phoneNumberId argument exists only to find which WABA's credentials to
   * use.
   *
   * Returns null (rather than throwing) when this number has no `wabaId`
   * stored, matching `listTemplates`: an unconfigured number must not be
   * mistaken for a rejected template.
   */
  async submitTemplate(
    params: SubmitTemplateParams,
  ): Promise<BspTemplateSubmission | null> {
    let wabaId: string;
    let accessToken: string;
    try {
      wabaId = await this.credentials.getCredential(
        params.phoneNumberId,
        'wabaId',
      );
      accessToken = await this.credentials.getCredential(
        params.phoneNumberId,
        'accessToken',
      );
    } catch {
      this.logger.warn(
        `MetaCloudAdapter: cannot submit template for ${params.phoneNumberId} — no wabaId stored with its credentials.`,
        MetaCloudAdapter.name,
      );
      return null;
    }

    // A rejection is surfaced verbatim rather than paraphrased
    // (MetaGraphError carries Meta's own message): it names the exact policy
    // or formatting rule that was broken, and it is the only clue a tenant
    // has for fixing the template.
    const created = await this.numberCall(
      params.phoneNumberId,
      this.graph.post(
        `${wabaId}/message_templates`,
        buildTemplateSubmissionPayload(params),
        accessToken,
      ),
      'MetaCloudAdapter: template submission',
    );
    return parseTemplateSubmission(created);
  }

  /** One place for the endpoint and credential lookup every send shares; auth, timeout and the error envelope live in MetaGraphClient. */
  private async send(
    phoneNumberId: string,
    payload: Record<string, unknown>,
  ): Promise<SendTextMessageResult> {
    const accessToken = await this.credentials.getCredential(
      phoneNumberId,
      'accessToken',
    );

    // Meta's error envelope (error.code / error.message) is carried by the
    // MetaGraphError the client throws; the bearer token never is.
    const body = await this.numberCall(
      phoneNumberId,
      this.graph.post(`${phoneNumberId}/messages`, payload, accessToken),
      'MetaCloudAdapter: send',
    );
    const bspMessageId = parseSentMessageId(body);
    if (!bspMessageId) {
      throw new MetaGraphError(
        200,
        null,
        null,
        'MetaCloudAdapter: send succeeded but the response carried no message id.',
      );
    }
    return { bspMessageId };
  }

  /**
   * A Graph call made with `phoneNumberId`'s token: names the operation on
   * failure (withOperation) and, when Meta says the token itself is dead,
   * records `reconnect_required` for the number before rethrowing.
   */
  private async numberCall<T>(
    phoneNumberId: string,
    call: Promise<T>,
    operation: string,
  ): Promise<T> {
    try {
      return await withOperation(call, operation);
    } catch (error) {
      if (error instanceof MetaGraphError && error.isAccessTokenRevoked) {
        await this.markTokenRevoked(phoneNumberId);
      }
      throw error;
    }
  }

  /** Best effort: failing to record the state must never mask the send error. */
  private async markTokenRevoked(phoneNumberId: string): Promise<void> {
    try {
      const affected = await this.health.transitionByPhoneNumberId(
        phoneNumberId,
        degrade('reconnect_required', CONNECTION_REASONS.tokenRevoked),
      );
      if (affected.length > 0) {
        this.logger.warn(
          `MetaCloudAdapter: Meta refused the access token for ${phoneNumberId}; number marked reconnect_required.`,
          MetaCloudAdapter.name,
        );
      }
    } catch (error) {
      this.logger.warn(
        `MetaCloudAdapter: could not mark ${phoneNumberId} reconnect_required: ${error instanceof Error ? error.message : String(error)}`,
        MetaCloudAdapter.name,
      );
    }
  }
}

/**
 * Awaits a Graph call and, if it fails with a MetaGraphError, rethrows a copy
 * whose message names the adapter operation (`"<operation> failed with HTTP
 * <status>: ..."`) — the same wording this adapter used before T1, so log
 * searches keep working. Network/timeout errors pass through untouched.
 */
async function withOperation<T>(
  call: Promise<T>,
  operation: string,
): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw error instanceof MetaGraphError
      ? error.withOperation(operation)
      : error;
  }
}

/**
 * Meta's template creation body.
 *
 * `example.body_text` is a list of PARAMETER SETS, not a list of parameters —
 * one inner array per example row, each holding one value per `{{n}}`. We send
 * exactly one row. Getting this nesting wrong is the single most common way
 * this call 400s, and Meta's error for it does not say so.
 *
 * The `example` key is omitted entirely when the body has no placeholders;
 * sending an empty one is itself a validation error.
 */
function buildTemplateSubmissionPayload(
  params: SubmitTemplateParams,
): Record<string, unknown> {
  const component: Record<string, unknown> = {
    type: 'BODY',
    text: params.body,
  };
  if (params.bodyExamples.length > 0) {
    component.example = { body_text: [params.bodyExamples] };
  }

  return {
    name: params.name,
    language: params.language,
    category: params.category,
    components: [component],
  };
}

/** Meta answers a creation with `{ id, status, category }`. A missing status means accepted-but-unstated, which is `PENDING`. */
function parseTemplateSubmission(payload: unknown): BspTemplateSubmission {
  const row = (payload ?? {}) as Record<string, unknown>;
  return {
    providerTemplateId: typeof row.id === 'string' ? row.id : null,
    status:
      typeof row.status === 'string' ? row.status.toUpperCase() : 'PENDING',
    category: typeof row.category === 'string' ? row.category : null,
  };
}

/** Meta's listing shape: `{ data: [{ name, language, status, category, rejected_reason }] }`. Unknown rows are skipped rather than throwing — one malformed entry should not lose the sync for every other template. */
function parseTemplateListing(payload: unknown): BspTemplateStatus[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  return data.flatMap((entry): BspTemplateStatus[] => {
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== 'string' || typeof row.status !== 'string') {
      return [];
    }
    return [
      {
        name: row.name,
        language: typeof row.language === 'string' ? row.language : 'en',
        status: row.status.toUpperCase(),
        category: typeof row.category === 'string' ? row.category : null,
        reason:
          typeof row.rejected_reason === 'string' ? row.rejected_reason : null,
      },
    ];
  });
}
