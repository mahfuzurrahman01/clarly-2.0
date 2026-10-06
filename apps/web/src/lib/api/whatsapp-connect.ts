// WhatsApp number connect + status (Gulf T3; health fields from T5).
// Contract: docs/HANDOFF.md "Gulf T3 — WhatsApp Embedded Signup".
import { apiFetch, browserApiFetch } from "./client";

/** Gulf D5 connection state, shared with the API's CHECK constraint. */
export type WhatsappConnectionState =
  | "active"
  | "reconnect_required"
  | "restricted"
  | "disconnected";

/**
 * Number health from Meta. Written by Gulf T5 (WABA webhooks + daily
 * reconcile), which ships in parallel with this UI: every field is optional
 * and nullable, and the UI renders only what is present. Values are Meta's
 * own enums, kept as strings so a new value degrades to "shown as-is"
 * instead of a type error.
 */
export type WhatsappNumberHealth = {
  /** Meta quality rating: GREEN | YELLOW | RED | UNKNOWN. */
  qualityRating?: string | null;
  /** Meta messaging limit: TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED. */
  messagingLimitTier?: string | null;
  /** Display-name review: APPROVED | PENDING_REVIEW | DECLINED | ... */
  nameStatus?: string | null;
  /** False when Meta reports no payment method on the WABA. */
  paymentMethodAttached?: boolean | null;
  lastHealthCheckAt?: string | null;
  /** Digits only from the API (e.g. "15550783881"); format for display. */
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  /** Meta health_status.can_send_message: AVAILABLE | LIMITED | BLOCKED. */
  messagingHealth?: string | null;
  /** Every BLOCKED/LIMITED reason from the last check; [] when healthy. */
  healthIssues?: WhatsappHealthIssue[];
};

/** One reason from Meta's health_status (HANDOFF "Gulf T5"). Show as-is. */
export type WhatsappHealthIssue = {
  entityType: string;
  severity: "BLOCKED" | "LIMITED";
  errorCode: number | null;
  description: string;
  possibleSolution: string | null;
};

export type ConnectedWhatsappNumber = WhatsappNumberHealth & {
  id: string;
  phoneNumberId: string;
  connectionState: WhatsappConnectionState;
  /** Tenant-actionable sentence; null while active. Show as-is. */
  connectionError: string | null;
};

export type EmbeddedSignupInput = {
  /** FB.login authResponse.code. Single use, ~30 s TTL. Never stored or logged. */
  code: string;
  wabaId: string;
  /** Omit only when the WA_EMBEDDED_SIGNUP message had none (coexistence). */
  phoneNumberId?: string;
  /** Existing two-step verification PIN (6 digits), only for the retry. */
  pin?: string;
};

export type EmbeddedSignupResult = {
  id: string;
  phoneNumberId: string;
  connectionState: WhatsappConnectionState;
  connectionError: string | null;
  /** True: the number stays on the WhatsApp Business app too (D13). */
  coexistence: boolean;
};

export function listConnectedNumbers(token?: string) {
  const path = "/whatsapp/connect/numbers";
  return token
    ? apiFetch<ConnectedWhatsappNumber[]>(path, { token })
    : browserApiFetch<ConnectedWhatsappNumber[]>(path);
}

/** Any non-2xx means nothing was stored; a 201 always means it was (check connectionState). */
export function completeEmbeddedSignup(input: EmbeddedSignupInput) {
  return browserApiFetch<EmbeddedSignupResult>("/whatsapp/connect/embedded-signup", {
    method: "POST",
    json: input,
  });
}
