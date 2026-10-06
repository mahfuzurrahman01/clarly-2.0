// Runs one WhatsApp Embedded Signup popup and pairs its two outputs:
// the FB.login `code` (callback) and the WABA / phone-number ids
// (WA_EMBEDDED_SIGNUP `message` event). Meta does not promise which arrives
// first, so both are collected and the result settles once it has what it
// needs. The code is never stored or logged; it goes straight back to the
// caller, which must POST it within ~30 s.

import {
  type EmbeddedSignupEvent,
  isFacebookOrigin,
  parseEmbeddedSignupMessage,
} from "./embedded-signup-message";
import { type FbLoginOptions, type FbLoginResponse, facebookLogin } from "./facebook-sdk";

/** How long to wait for the FINISH message after the code arrives (the code's TTL is ~30 s). */
const FINISH_MESSAGE_GRACE_MS = 5_000;
/** After a login with no code, how long to wait for a CANCEL message carrying detail. */
const CANCEL_MESSAGE_GRACE_MS = 750;

export type EmbeddedSignupOutcome =
  | { status: "completed"; code: string; wabaId: string; phoneNumberId: string | null }
  | { status: "cancelled"; currentStep: string | null }
  | { status: "error"; errorMessage: string; errorCode: string | null }
  /** Meta returned a code but never told us which WABA was shared. */
  | { status: "missing_session" };

export type EmbeddedSignupLaunch = {
  configId: string;
  /** WhatsApp Business app number (coexistence, D13). */
  coexistence: boolean;
};

type LoginFn = (options: FbLoginOptions) => Promise<FbLoginResponse>;

export function embeddedSignupLoginOptions({
  configId,
  coexistence,
}: EmbeddedSignupLaunch): FbLoginOptions {
  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: coexistence
      ? {
          setup: {},
          featureType: "whatsapp_business_app_onboarding",
          sessionInfoVersion: "3",
        }
      : { setup: {} },
  };
}

/**
 * Starts the popup synchronously (call it straight from a click handler) and
 * resolves with the outcome. Never rejects for user-driven outcomes.
 */
export function runEmbeddedSignup(
  fb: Parameters<typeof facebookLogin>[0],
  launch: EmbeddedSignupLaunch,
  target: Window = window,
): Promise<EmbeddedSignupOutcome> {
  return runEmbeddedSignupWith((options) => facebookLogin(fb, options), launch, target);
}

/** Same as `runEmbeddedSignup` with the login injected (for tests). */
export function runEmbeddedSignupWith(
  login: LoginFn,
  launch: EmbeddedSignupLaunch,
  target: Pick<Window, "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout">,
): Promise<EmbeddedSignupOutcome> {
  let finish: Extract<EmbeddedSignupEvent, { kind: "finish" }> | null = null;
  let stopped: Exclude<EmbeddedSignupEvent, { kind: "finish" }> | null = null;
  let onEvent: (() => void) | null = null;

  const listener = (event: MessageEvent) => {
    if (!isFacebookOrigin(event.origin)) return;
    const parsed = parseEmbeddedSignupMessage(event.data);
    if (!parsed) return;
    if (parsed.kind === "finish") finish = parsed;
    else stopped = parsed;
    onEvent?.();
  };
  target.addEventListener("message", listener);

  // Awaits until `ready()` is true or `ms` elapses.
  const waitFor = (ready: () => boolean, ms: number) =>
    new Promise<void>((resolve) => {
      if (ready()) return resolve();
      const timer = target.setTimeout(() => {
        onEvent = null;
        resolve();
      }, ms);
      onEvent = () => {
        if (!ready()) return;
        target.clearTimeout(timer);
        onEvent = null;
        resolve();
      };
    });

  const stoppedOutcome = (): EmbeddedSignupOutcome => {
    const s = stopped as Exclude<EmbeddedSignupEvent, { kind: "finish" }> | null;
    if (s?.kind === "error") {
      return { status: "error", errorMessage: s.errorMessage, errorCode: s.errorCode };
    }
    return { status: "cancelled", currentStep: s?.kind === "cancel" ? s.currentStep : null };
  };

  return login(embeddedSignupLoginOptions(launch))
    .then(async (response): Promise<EmbeddedSignupOutcome> => {
      const code = response.authResponse?.code;
      if (!code) {
        await waitFor(() => stopped !== null, CANCEL_MESSAGE_GRACE_MS);
        return stoppedOutcome();
      }
      await waitFor(() => finish !== null, FINISH_MESSAGE_GRACE_MS);
      const f = finish as Extract<EmbeddedSignupEvent, { kind: "finish" }> | null;
      if (!f) return { status: "missing_session" };
      return { status: "completed", code, wabaId: f.wabaId, phoneNumberId: f.phoneNumberId };
    })
    .finally(() => {
      onEvent = null;
      target.removeEventListener("message", listener);
    });
}
