// Facebook JS SDK loader + a typed, promise-shaped FB.login.
//
// Shapes follow Meta's docs (checked 2026-09-19):
// - https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
//   (script tag, FB.init params, FB.login with config_id / response_type:
//   'code' / override_default_response_type / extras)
// - https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
//   (FB.login with only config_id for a User-access-token configuration)
//
// The SDK is loaded once per page and shared by both connect flows
// (WhatsApp Embedded Signup and Facebook/Instagram page connect).

import type { MetaSdkConfig } from "@/lib/env";

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
const SDK_SCRIPT_ID = "facebook-jssdk";
/** Script load + FB.init; generous for slow links, finite so the UI can say it failed. */
const SDK_LOAD_TIMEOUT_MS = 20_000;

export type FbAuthResponse = {
  /** Present for a User-access-token configuration (Gulf T4 page connect). */
  accessToken?: string;
  /** Present with response_type: 'code' (Embedded Signup). Single use, ~30 s TTL. */
  code?: string;
  userID?: string;
  expiresIn?: number;
};

export type FbLoginResponse = {
  status?: "connected" | "not_authorized" | "unknown" | string;
  authResponse: FbAuthResponse | null;
};

export type FbLoginOptions = {
  config_id: string;
  response_type?: "code";
  override_default_response_type?: boolean;
  extras?: Record<string, unknown>;
};

type FacebookSdk = {
  init(params: {
    appId: string;
    autoLogAppEvents?: boolean;
    xfbml?: boolean;
    version: string;
  }): void;
  // The SDK rejects an async callback, so this stays a plain function type.
  login(callback: (response: FbLoginResponse) => void, options: FbLoginOptions): void;
};

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<FacebookSdk> | null = null;

/**
 * Loads and initialises the SDK once. Later calls share the same promise; a
 * failed load resets it so the next call retries.
 */
export function loadFacebookSdk(
  config: Pick<MetaSdkConfig, "appId" | "graphVersion">,
): Promise<FacebookSdk> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("The Facebook SDK only runs in the browser"));
  }
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise<FacebookSdk>((resolve, reject) => {
    const init = (fb: FacebookSdk) => {
      fb.init({
        appId: config.appId,
        autoLogAppEvents: true,
        xfbml: true,
        version: config.graphVersion,
      });
      resolve(fb);
    };

    if (window.FB) {
      init(window.FB);
      return;
    }

    const timer = window.setTimeout(
      () => reject(new Error("The Facebook SDK took too long to load")),
      SDK_LOAD_TIMEOUT_MS,
    );
    window.fbAsyncInit = () => {
      window.clearTimeout(timer);
      if (window.FB) init(window.FB);
      else reject(new Error("The Facebook SDK loaded without FB"));
    };

    if (document.getElementById(SDK_SCRIPT_ID)) return;
    const script = document.createElement("script");
    script.id = SDK_SCRIPT_ID;
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("The Facebook SDK could not be loaded"));
    };
    document.body.appendChild(script);
  }).catch((err: unknown) => {
    sdkPromise = null;
    throw err;
  });

  return sdkPromise;
}

/**
 * FB.login as a promise. Must be called synchronously from a click handler
 * (with the SDK already loaded) or the browser blocks the popup.
 */
export function facebookLogin(
  fb: FacebookSdk,
  options: FbLoginOptions,
): Promise<FbLoginResponse> {
  return new Promise((resolve) => {
    fb.login((response) => resolve(response), options);
  });
}
