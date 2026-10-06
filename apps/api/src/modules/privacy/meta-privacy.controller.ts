// Privacy (PrivacyModule, Gulf T7 / D7): the three URLs the Meta App
// Dashboard needs before the app can go Live.
//
//   POST /meta/data-deletion                 Data Deletion Request callback
//   GET  /meta/data-deletion/status/:code    the status URL we hand back
//   POST /meta/deauthorize                   Deauthorize callback
//
// Public, like the other Meta/Stripe webhooks — Meta has no tenant JWT to
// send. Trust comes entirely from the signed_request HMAC, verified before
// anything is read from the database. Meta POSTs it form-encoded
// (`signed_request=...`, per its sample reading `$_POST['signed_request']`);
// Express's default urlencoded + JSON parsers both land it on `body`.
//
// Status codes: 400 malformed, 401 bad signature / wrong algorithm, 503 when
// this deployment has no app secret or public base URL configured (a
// configuration state Meta should retry, not a fault).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AppConfigService, AppLoggerService } from '../core';
import { WebhookRateLimiterService } from '../webhook/webhook-rate-limiter.service';
import {
  MetaDataDeletionService,
  type DeletionRequestStatus,
} from './meta-data-deletion.service';
import { MetaDeauthorizeService } from './meta-deauthorize.service';
import { InvalidSignedRequestError } from './meta-signed-request';
import type { MetaSignedRequest } from './meta-signed-request';
import { MetaSignedRequestVerifier } from './meta-signed-request-verifier.service';
import { renderDeletionStatusPage } from './deletion-status.page';

export const signedRequestBodySchema = z.object({
  signed_request: z.string().min(1).max(8192),
});
type SignedRequestBody = z.infer<typeof signedRequestBodySchema>;

/** Per-client budget for the public status page — the only unauthenticated route here that reads the database. */
const STATUS_LOOKUPS_PER_MINUTE = 60;

export interface DataDeletionCallbackResponse {
  url: string;
  confirmation_code: string;
}

@ApiExcludeController()
@Controller('meta')
export class MetaPrivacyController {
  constructor(
    private readonly verifier: MetaSignedRequestVerifier,
    private readonly deletion: MetaDataDeletionService,
    private readonly deauthorize: MetaDeauthorizeService,
    private readonly rateLimiter: WebhookRateLimiterService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  @Post('data-deletion')
  @HttpCode(200)
  async dataDeletion(
    @Body(new ZodValidationPipe(signedRequestBodySchema))
    body: SignedRequestBody,
  ): Promise<DataDeletionCallbackResponse> {
    const baseUrl = this.config.apiPublicBaseUrl.replace(/\/+$/, '');
    if (!baseUrl) {
      // Meta requires a status URL in the response; answering without one
      // would be a broken contract, so refuse before doing anything.
      this.logger.error(
        'meta data-deletion callback refused: API_PUBLIC_BASE_URL is not set, so no status URL can be returned',
        undefined,
        MetaPrivacyController.name,
      );
      throw new ServiceUnavailableException(
        'Data deletion callback is not configured on this deployment.',
      );
    }

    const parsed = this.verify(body.signed_request, 'data-deletion');
    const result = await this.deletion.request(body.signed_request, parsed);

    return {
      url: `${baseUrl}/meta/data-deletion/status/${result.confirmationCode}`,
      confirmation_code: result.confirmationCode,
    };
  }

  /**
   * The page Meta links the user to. HTML for a person in a browser (Meta
   * requires "a human-readable explanation of the status"); JSON when asked
   * for with `Accept: application/json`. Unknown and malformed codes get the
   * same 404 — the difference is what an enumerator would be looking for.
   */
  @Get('data-deletion/status/:code')
  async deletionStatus(
    @Param('code') code: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const allowed = await this.rateLimiter.allow(
      `meta-deletion-status:${req.ip ?? 'unknown'}`,
      STATUS_LOOKUPS_PER_MINUTE,
    );
    if (!allowed) {
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Set by hand: @Header() is not applied when the handler takes @Res().
    res.setHeader('Cache-Control', 'no-store');
    const status = await this.deletion.status(code);
    if (!status) {
      throw new NotFoundException('No such data deletion request.');
    }

    if (req.accepts(['html', 'json']) === 'json') {
      res.json(toStatusJson(status));
      return;
    }
    res.type('html').send(renderDeletionStatusPage(status));
  }

  @Post('deauthorize')
  @HttpCode(200)
  async deauthorizeCallback(
    @Body(new ZodValidationPipe(signedRequestBodySchema))
    body: SignedRequestBody,
  ): Promise<{ received: true }> {
    const parsed = this.verify(body.signed_request, 'deauthorize');
    await this.deauthorize.handle(parsed);
    // Deliberately empty of detail: echoing what matched would tell anyone
    // holding a valid signature which users have connected channels.
    return { received: true };
  }

  private verify(signedRequest: string, route: string): MetaSignedRequest {
    try {
      return this.verifier.verify(signedRequest);
    } catch (error) {
      if (!(error instanceof InvalidSignedRequestError)) throw error;

      this.logger.warn(
        `meta ${route} callback rejected: ${error.kind}`,
        MetaPrivacyController.name,
      );
      switch (error.kind) {
        case 'not_configured':
          throw new ServiceUnavailableException(
            'Meta app secret is not configured on this deployment.',
          );
        case 'malformed':
          throw new BadRequestException('Malformed signed_request');
        default:
          throw new UnauthorizedException('Invalid signed_request');
      }
    }
  }
}

function toStatusJson(status: DeletionRequestStatus) {
  return {
    confirmation_code: status.confirmationCode,
    status: status.status,
    requested_at: status.requestedAt.toISOString(),
    completed_at: status.completedAt?.toISOString() ?? null,
  };
}
