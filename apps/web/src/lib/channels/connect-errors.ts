// Maps connect-API failures to user-facing copy, per the status tables in
// docs/HANDOFF.md "Gulf T3" (WhatsApp) and "Gulf T4" (Facebook/Instagram).
import { ApiError, isSubscriptionInactiveError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import type { Dictionary } from "@/lib/i18n/get-dictionary";

export type ConnectErrorCopy = {
  message: string;
  /** The server's own sentence, when it adds something the headline doesn't. */
  detail?: string;
};

function serverDetail(err: ApiError): string | undefined {
  const m = err.message;
  // Skip the client's generic fallback and non-string validation payloads.
  if (!m || m.startsWith("Request failed") || m.includes("[object Object]")) return undefined;
  return m;
}

/** POST /whatsapp/connect/embedded-signup. Any non-2xx means nothing was stored. */
export function embeddedSignupErrorCopy(err: unknown, t: Dictionary): ConnectErrorCopy {
  const c = t.channels;
  if (!(err instanceof ApiError) || err.status === 0) {
    return { message: apiErrorMessage(err, t, c.couldNotConnect) };
  }
  switch (err.status) {
    case 400:
      // Expired/reused code, or a multi-number WABA sent without a phone id.
      return { message: c.errorCodeExpired, detail: serverDetail(err) };
    case 403:
      // Lapsed subscription (the app-wide upgrade dialog also opens), WABA not
      // shared with us, or number not on that WABA: the server's sentence says which.
      if (isSubscriptionInactiveError(err)) return { message: err.message };
      return { message: serverDetail(err) ?? c.errorForbidden };
    case 409:
      return { message: c.errorConflict };
    case 502:
    case 504:
      return { message: c.errorMeta };
    default:
      return { message: apiErrorMessage(err, t, c.couldNotConnect) };
  }
}

/** POST /channels/meta/pages (step A). */
export function socialHandshakeErrorCopy(err: unknown, t: Dictionary): ConnectErrorCopy {
  const c = t.channels;
  if (err instanceof ApiError && err.status === 400) {
    return { message: c.socialErrorLogin, detail: serverDetail(err) };
  }
  if (err instanceof ApiError && err.status === 502) return { message: c.socialErrorMeta };
  return { message: apiErrorMessage(err, t, c.couldNotLoadPages) };
}

/** POST /channels/meta (step B). */
export function socialConnectErrorCopy(err: unknown, t: Dictionary): ConnectErrorCopy {
  const c = t.channels;
  if (!(err instanceof ApiError) || err.status === 0) {
    return { message: apiErrorMessage(err, t, c.couldNotConnectPage) };
  }
  switch (err.status) {
    case 403:
      if (isSubscriptionInactiveError(err)) return { message: err.message };
      return { message: c.socialErrorForbidden };
    case 409:
      return { message: c.socialErrorConflict };
    case 410:
      return { message: c.socialErrorExpired };
    case 422:
      return { message: c.socialErrorNoInstagram };
    case 502:
      return { message: c.socialErrorMeta };
    default:
      return { message: apiErrorMessage(err, t, c.couldNotConnectPage) };
  }
}

/** True when the handshake is gone and the picker must restart at Facebook Login. */
export function isHandshakeExpired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 410;
}
