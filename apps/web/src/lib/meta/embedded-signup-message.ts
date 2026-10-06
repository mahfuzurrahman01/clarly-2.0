// Parsing for Embedded Signup's session-logging `message` events.
//
// Meta posts these from the popup to `window` (docs checked 2026-09-19,
// https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
// and .../onboarding-business-app-users):
//
//   { type: "WA_EMBEDDED_SIGNUP", event: "FINISH",
//     data: { phone_number_id, waba_id, business_id, ... } }
//   { type: "WA_EMBEDDED_SIGNUP", event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
//     data: { waba_id }, version: 3 }                      // coexistence: no phone id
//   { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step } }
//   { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL",
//     data: { error_message, error_code, session_id, timestamp } }  // reported error
//
// `event.data` arrives as a JSON string. The FB.login `code` does not carry
// the WABA or phone-number id; these messages are the only source.

export const EMBEDDED_SIGNUP_MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";

export type EmbeddedSignupEvent =
  | { kind: "finish"; wabaId: string; phoneNumberId: string | null }
  | { kind: "cancel"; currentStep: string | null }
  | { kind: "error"; errorMessage: string; errorCode: string | null; sessionId: string | null };

const GRAPH_ID = /^\d{1,32}$/;

/**
 * True only for an https origin on facebook.com or one of its subdomains.
 * Stricter than Meta's sample (`origin.endsWith('facebook.com')`, which
 * would also accept e.g. `https://evilfacebook.com`).
 */
export function isFacebookOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function graphIdField(record: Record<string, unknown>, key: string): string | null {
  const value = stringField(record, key);
  return value && GRAPH_ID.test(value) ? value : null;
}

/**
 * Turns a raw `MessageEvent.data` into an Embedded Signup event, or null for
 * anything else (other SDK chatter, malformed JSON, a FINISH without a
 * usable WABA id). Callers must check the origin first.
 */
export function parseEmbeddedSignupMessage(raw: unknown): EmbeddedSignupEvent | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const message = asRecord(parsed);
  if (!message || message.type !== EMBEDDED_SIGNUP_MESSAGE_TYPE) return null;

  const event = typeof message.event === "string" ? message.event : "";
  const data = asRecord(message.data) ?? {};

  // FINISH, FINISH_ONLY_WABA, FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, ...
  if (event === "FINISH" || event.startsWith("FINISH_")) {
    const wabaId = graphIdField(data, "waba_id");
    if (!wabaId) return null;
    return { kind: "finish", wabaId, phoneNumberId: graphIdField(data, "phone_number_id") };
  }

  if (event === "CANCEL" || event === "ERROR") {
    const errorMessage = stringField(data, "error_message");
    if (errorMessage) {
      return {
        kind: "error",
        errorMessage,
        errorCode: stringField(data, "error_code"),
        sessionId: stringField(data, "session_id"),
      };
    }
    return { kind: "cancel", currentStep: stringField(data, "current_step") };
  }

  return null;
}
