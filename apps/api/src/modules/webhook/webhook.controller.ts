// Channel (WebhookModule, T6/T11): the HTTP endpoint Meta calls with
// inbound WhatsApp messages — a small addition on top of
// WebhookIngestService rather than a redesign.
//
// Like BillingWebhookController, this is NOT behind TenantAuthMiddleware/
// RolesGuard: the BSP has no tenant JWT to send. Trust comes entirely from
// the `X-Hub-Signature-256` HMAC, verified inside WebhookIngestService
// via the bound BspAdapter before a single byte of the payload is parsed.
//
// ACK discipline (T11's <1s budget): every per-message outcome —
// duplicate, rate-limited, escalated, enqueued — resolves to HTTP 200.
// Only two things are non-200, and both are genuine "this delivery was not
// accepted" cases the BSP should see: a failed signature (401) and a
// phone_number_id no tenant has connected (404). Anything else propagates
// as a 500, which is correct: Meta retries, and the alternative
// (swallowing an internal failure as 200) silently loses the message.
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { WhatsappChannelAdapter } from '../channel/whatsapp-channel.adapter';
import { WabaHealthWebhookService } from '../whatsapp/whatsapp.module';
import { UnknownChannelAccountError } from './channel-tenant-resolver.service';
import {
  WebhookIngestService,
  WebhookSignatureVerificationError,
} from './webhook-ingest.service';

@ApiExcludeController()
@Controller('webhooks/whatsapp')
export class WebhookController {
  constructor(
    private readonly ingest: WebhookIngestService,
    // Feature 16: the WhatsApp binding of the shared ChannelAdapter port, not
    // the raw BspAdapter. Same object underneath — WhatsappChannelAdapter is
    // a translation, not a reimplementation — but it means this controller
    // and the Meta one hand WebhookIngestService the same kind of thing.
    private readonly channelAdapter: WhatsappChannelAdapter,
    // Gulf T5 (D5): the WABA health fields (account_update,
    // phone_number_quality_update, phone_number_name_update) arrive on this
    // same endpoint and carry no messages.
    private readonly wabaHealth: WabaHealthWebhookService,
  ) {}

  /**
   * Meta's webhook subscription handshake. The console issues this GET
   * when a callback URL is saved and refuses to register the webhook
   * unless `hub.challenge` is echoed back verbatim as plain text — a JSON
   * body, or the challenge wrapped in anything, fails registration.
   *
   * Delegated to the bound adapter (`verifySubscription`) rather than read
   * from config here, because this is a Meta-only ceremony: the no-op
   * binding inherits the port's default null and rejects.
   */
  @Get()
  @Header('Content-Type', 'text/plain')
  handleSubscription(@Query() query: Record<string, string>): string {
    const challenge = this.channelAdapter.verifySubscription(query);
    if (challenge === null) {
      throw new ForbiddenException('Webhook subscription verification failed');
    }
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    if (!req.rawBody) {
      // main.ts sets rawBody app-wide; reaching here means the exact bytes
      // the signature covers are unavailable, so nothing can be verified.
      throw new BadRequestException('Missing raw request body');
    }

    try {
      await this.ingest.ingest(
        this.channelAdapter,
        req.rawBody,
        // Express lowercases incoming header names; the adapter also
        // matches case-insensitively, so array-valued headers (never the
        // case for the signature header) are the only thing dropped here.
        req.headers as Record<string, string>,
      );
    } catch (error) {
      if (error instanceof WebhookSignatureVerificationError) {
        throw new UnauthorizedException('Invalid webhook signature');
      }
      if (error instanceof UnknownChannelAccountError) {
        throw new NotFoundException('Unrecognized WhatsApp number');
      }
      throw error;
    }

    // Only reached once ingest() has verified the signature over these exact
    // bytes, so the health handler can trust them. A failed write
    // propagates as a 500 and Meta redelivers; the messages in the batch are
    // already deduped, and every health write is idempotent.
    await this.wabaHealth.apply(req.rawBody);

    // Deliberately empty of per-message detail: the BSP has no use for it,
    // and echoing outcomes back would leak whether a given number/tenant
    // exists to anyone who obtains a valid signature.
    return { received: true };
  }
}
