// Channel/connect (WhatsappModule, Gulf T3 / D3): the Meta Embedded Signup
// half of connecting a WhatsApp number. A narrow port so ConnectService
// holds the ORDER and the trust decisions (which WABA, which number, what
// gets stored) while the adapter only speaks Graph. Bound in ConnectModule
// to MetaEmbeddedSignupAdapter; tests bind a fake.
//
// Every method takes the business token explicitly and never stores it:
// persistence is ConnectService's job, through WhatsappConnectionService.

/** A phone number on the tenant's WABA, as Meta lists it. */
export interface EmbeddedSignupPhoneNumber {
  id: string;
  displayPhoneNumber: string | null;
  /**
   * D13: true when the number is ALSO in use on the WhatsApp Business app
   * (coexistence onboarding). Such a number is already registered: calling
   * `/register` on it is wrong, and its phone-app messages arrive as
   * `smb_message_echoes`.
   */
  isOnBizApp: boolean;
}

/** The WABA ids a business token was granted, per WhatsApp permission. */
export interface EmbeddedSignupGrant {
  /** False when Meta says the token is invalid or it was issued to a different app. */
  valid: boolean;
  managementWabaIds: string[];
  messagingWabaIds: string[];
  /**
   * Gulf T5: the Meta user the business token belongs to (debug_token
   * `user_id`). Stored hashed so the deauthorize callback can find the
   * number. Null when Meta does not say.
   */
  metaUserId: string | null;
}

/**
 * Why a Graph step failed, in the only terms ConnectService branches on.
 * Vendor error codes stay inside the adapter.
 */
export type EmbeddedSignupFailure =
  /** The popup's `code` was rejected: reused, expired, or never ours. */
  | 'invalid_code'
  /** `/register` refused the PIN: the number already has two-step verification with a different PIN (Meta 133005). */
  | 'pin_mismatch'
  /** Too many PIN attempts, or attempts too fast (Meta 133008 / 133009 / 133016): retrying now only makes it worse. */
  | 'pin_locked'
  /** Anything else: Meta down, permissions, a number in a state we cannot fix. */
  | 'upstream';

export class EmbeddedSignupError extends Error {
  constructor(
    public readonly failure: EmbeddedSignupFailure,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddedSignupError';
  }
}

export abstract class EmbeddedSignupPort {
  /** Exchanges the popup's single-use `code` for a business integration system user token. */
  abstract exchangeCode(code: string): Promise<string>;

  /** debug_token: which WABAs the token was actually granted on. */
  abstract inspectGrant(accessToken: string): Promise<EmbeddedSignupGrant>;

  /** `GET /{waba-id}/phone_numbers`. */
  abstract listPhoneNumbers(
    wabaId: string,
    accessToken: string,
  ): Promise<EmbeddedSignupPhoneNumber[]>;

  /** `POST /{waba-id}/subscribed_apps`: webhooks for this WABA reach our app. */
  abstract subscribeApp(wabaId: string, accessToken: string): Promise<void>;

  /** `POST /{phone-number-id}/register` with the two-step verification PIN. */
  abstract registerPhoneNumber(
    phoneNumberId: string,
    pin: string,
    accessToken: string,
  ): Promise<void>;
}
