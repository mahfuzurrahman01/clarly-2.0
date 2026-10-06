// Clarly 2.0 S3: the four endpoints the embedded widget calls, from any
// website. Public (no JWT), so each one checks, in this order:
//   1. a valid, ENABLED widget key (and an open workspace);
//   2. the browser's Origin is on that widget's allow-list;
//   3. per-IP and per-visitor rate limits (Redis, shared by all replicas);
//   4. for message reads/writes, a visitor token the API itself signed.
// A failure at 1 or 2 is a 404/403 with no detail, so the endpoints cannot
// be used to discover which keys exist.
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AppConfigService } from '../core';
import { WebhookIngestService } from '../webhook/webhook-ingest.service';
import {
  WidgetConfigService,
  type PublicWidget,
} from './widget-config.service';
import {
  WidgetConversationService,
  widgetProviderMessageId,
} from './widget-conversation.service';
import { isOriginAllowed } from './widget-origin';
import {
  WIDGET_LIMITS,
  WidgetRateLimiterService,
  type WidgetLimit,
} from './widget-rate-limiter.service';
import {
  deriveWidgetTokenKey,
  newVisitorId,
  signVisitor,
  verifyVisitor,
} from './widget-token';
import {
  publicConfigQuerySchema,
  publicMessagesQuerySchema,
  publicSendBodySchema,
  publicSessionBodySchema,
  type PublicMessagesQuery,
  type PublicSendBody,
  type PublicWidgetConfig,
  type PublicWidgetMessage,
} from './widget.dto';

@ApiExcludeController()
@Controller('widget/v1')
export class WidgetPublicController {
  private readonly tokenKey: Buffer;

  constructor(
    private readonly widgets: WidgetConfigService,
    private readonly conversations: WidgetConversationService,
    private readonly limiter: WidgetRateLimiterService,
    private readonly ingest: WebhookIngestService,
    config: AppConfigService,
  ) {
    this.tokenKey = deriveWidgetTokenKey(config.bspCredentialsEncryptionKey);
  }

  @Get('config')
  async config(
    @Req() req: Request,
    @Query(new ZodValidationPipe(publicConfigQuerySchema))
    query: { key: string },
  ): Promise<PublicWidgetConfig> {
    await this.limit('config', clientIp(req), WIDGET_LIMITS.configPerIp);
    const widget = await this.authorise(req, query.key);
    return {
      title: widget.row.title,
      welcomeMessage: widget.row.welcomeMessage,
      accentColor: widget.row.accentColor,
      position: widget.row.position,
      locale: widget.row.locale,
      businessName: widget.businessName,
    };
  }

  @Post('session')
  @HttpCode(HttpStatus.CREATED)
  async session(
    @Req() req: Request,
    @Body(new ZodValidationPipe(publicSessionBodySchema)) body: { key: string },
  ): Promise<{ visitorId: string; token: string }> {
    await this.limit('session', clientIp(req), WIDGET_LIMITS.sessionPerIp);
    const widget = await this.authorise(req, body.key);
    const visitorId = newVisitorId();
    return {
      visitorId,
      token: signVisitor(this.tokenKey, widget.row.id, visitorId),
    };
  }

  @Post('messages')
  @HttpCode(HttpStatus.ACCEPTED)
  async send(
    @Req() req: Request,
    @Body(new ZodValidationPipe(publicSendBodySchema)) body: PublicSendBody,
  ): Promise<{ accepted: true }> {
    await this.limit('send-ip', clientIp(req), WIDGET_LIMITS.sendPerIp);
    const widget = await this.authorise(req, body.key);
    this.requireVisitor(widget, body.visitorId, body.token);
    await this.limit('send', body.visitorId, WIDGET_LIMITS.sendPerVisitor);

    const [result] = await this.ingest.ingestMessages([
      {
        channel: 'web',
        channelAccountId: widget.row.id,
        providerMessageId: widgetProviderMessageId(body.clientMessageId),
        from: body.visitorId,
        type: 'text',
        text: body.text,
        receivedAt: new Date(),
      },
    ]);
    if (result?.outcome === 'rate_limited') {
      throw new HttpException(
        'Too many messages, try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return { accepted: true };
  }

  @Get('messages')
  async messages(
    @Req() req: Request,
    @Query(new ZodValidationPipe(publicMessagesQuerySchema))
    query: PublicMessagesQuery,
  ): Promise<{ messages: PublicWidgetMessage[] }> {
    const widget = await this.authorise(req, query.key);
    this.requireVisitor(widget, query.visitorId, query.token);
    await this.limit('read', query.visitorId, WIDGET_LIMITS.readPerVisitor);
    return {
      messages: await this.conversations.messagesFor(
        widget.row.tenantId,
        query.visitorId,
        query.after,
      ),
    };
  }

  // --- checks --------------------------------------------------------------

  private async authorise(req: Request, key: string): Promise<PublicWidget> {
    const widget = await this.widgets.findEnabledByKey(key);
    if (!widget) throw new NotFoundException();
    if (!isOriginAllowed(req.headers.origin, widget.row.allowedOrigins)) {
      throw new ForbiddenException(
        'This website is not allowed to use this widget.',
      );
    }
    return widget;
  }

  private requireVisitor(
    widget: PublicWidget,
    visitorId: string,
    token: string,
  ): void {
    if (!verifyVisitor(this.tokenKey, widget.row.id, visitorId, token)) {
      throw new ForbiddenException('Invalid visitor session.');
    }
  }

  private async limit(
    bucket: string,
    subject: string,
    limit: WidgetLimit,
  ): Promise<void> {
    if (!(await this.limiter.allow(bucket, subject, limit))) {
      throw new HttpException(
        'Too many requests, try again shortly.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

/** `req.ip` honours Express's `trust proxy` (TRUST_PROXY_HOPS); never a raw X-Forwarded-For. */
function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}
