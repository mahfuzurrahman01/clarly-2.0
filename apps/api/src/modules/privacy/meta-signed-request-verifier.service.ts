// Privacy (PrivacyModule, Gulf T7 / D7): binds parseMetaSignedRequest() to
// the configured Meta app secret. The only thing either callback trusts.
//
// Uses `metaAppSecret` (META_APP_SECRET, with the deprecated META_SOCIAL_APP_SECRET alias): one Meta
// app fronts WhatsApp, Messenger and Instagram, and the privacy callbacks are
// configured once per APP in the App Dashboard, not per product.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import {
  parseMetaSignedRequest,
  type MetaSignedRequest,
} from './meta-signed-request';

@Injectable()
export class MetaSignedRequestVerifier {
  constructor(private readonly config: AppConfigService) {}

  /** @throws InvalidSignedRequestError */
  verify(signedRequest: string): MetaSignedRequest {
    return parseMetaSignedRequest(signedRequest, this.config.metaAppSecret);
  }
}
