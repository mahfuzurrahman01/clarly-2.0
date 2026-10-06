// Channel (WebhookModule, Feature 16 / T6/T11): the HTTP endpoint Meta calls
// with inbound Facebook Messenger and Instagram DM traffic.
//
// A near-exact twin of `WebhookController`, and that similarity is the
// evidence the shared port did its job: the entire body of both is "hand the
// bytes to the same WebhookIngestService with a different adapter". Nothing
// downstream — dedup (T6), rate limiting (T17), serialization (T10), the
// async job boundary (T11), the agent turn — has a Messenger-specific line
// in it.
//
// ONE endpoint for both social channels, not two. Meta delivers Messenger and
// Instagram over the same webhook subscription with the product named in the
// payload's `object` field; the parser reads it and tags each message with
// its own channel, so a single route is what Meta actually sends rather than
// a shortcut. The Messenger binding is used to verify and parse because the
// signature scheme and the envelope are identical for both — see
// MetaChannelAdapter.
//
// Like WebhookController and BillingWebhookController this is NOT behind
// TenantAuthMiddleware/RolesGuard: Meta has no tenant JWT to send. Trust
// comes entirely from the `X-Hub-Signature-256` HMAC, verified before a
// single byte of the payload is parsed.
//
// ACK discipline (T11's <1s budget): every per-message outcome resolves to
// HTTP 200. Only a failed signature (401) and an account no tenant has
// connected (404) are non-200 — both are genuine "this delivery was not
// accepted" cases. Anything else propagates as a 500, which is correct: Meta
// retries, and swallowing an internal failure as 200 silently loses the
// message.
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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { ChannelRegistry } from '../channel/channel-registry.service';
import { UnsupportedChannelError } from '../channel/channel-policy.registry';
import type { ChannelAdapter } from '../channel/ports/channel-adapter.port';
import { CommentIngestService } from '../comments/comment-ingest.service';
import { UnknownChannelAccountError } from './channel-tenant-resolver.service';
import {
  WebhookIngestService,
  WebhookSignatureVerificationError,
} from './webhook-ingest.service';

@ApiExcludeController()
@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(
    private readonly ingest: WebhookIngestService,
    private readonly channels: ChannelRegistry,
    private readonly comments: CommentIngestService,
  ) {}

  /**
   * Meta's webhook subscription handshake. The App Dashboard issues this GET
   * when a callback URL is saved and refuses to register the webhook unless
   * `hub.challenge` is echoed back verbatim as plain text.
   */
  @Get()
  @Header('Content-Type', 'text/plain')
  handleSubscription(@Query() query: Record<string, string>): string {
    const challenge = this.adapter().verifySubscription(query);
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
      // Verifies X-Hub-Signature-256 before anything is parsed, and throws
      // on a forgery — so the comment branch below only ever sees a body
      // Meta signed.
      await this.ingest.ingest(
        this.adapter(),
        req.rawBody,
        req.headers as Record<string, string>,
      );
      // Gulf T8 (D6): page `feed` / Instagram `comments` changes on the same
      // delivery. Same route, same (already checked) signature.
      await this.comments.ingest(req.rawBody);
    } catch (error) {
      if (error instanceof WebhookSignatureVerificationError) {
        throw new UnauthorizedException('Invalid webhook signature');
      }
      if (error instanceof UnknownChannelAccountError) {
        throw new NotFoundException('Unrecognized Meta channel account');
      }
      throw error;
    }

    // Deliberately empty of per-message detail: Meta has no use for it, and
    // echoing outcomes back would leak whether a given account/tenant exists
    // to anyone who obtains a valid signature.
    return { received: true };
  }

  /**
   * The Messenger binding, which also verifies and parses Instagram traffic
   * (identical signature scheme and envelope — see this file's header).
   *
   * A 503, not a 500, when META_SOCIAL_CHANNELS_ENABLED is off: the route
   * exists but this deployment has no Meta binding, which is a configuration
   * state rather than a fault. Meta retries a 503, which is the right
   * behaviour if the switch is flipped on shortly afterwards.
   */
  private adapter(): ChannelAdapter {
    try {
      return this.channels.for('messenger');
    } catch (error) {
      if (error instanceof UnsupportedChannelError) {
        throw new ServiceUnavailableException(
          'Meta social channels are not enabled on this deployment.',
        );
      }
      throw error;
    }
  }
}
