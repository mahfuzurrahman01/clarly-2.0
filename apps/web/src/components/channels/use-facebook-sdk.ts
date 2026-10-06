"use client";

import { useEffect, useState } from "react";
import type { MetaSdkConfig } from "@/lib/env";
import { loadFacebookSdk } from "@/lib/meta/facebook-sdk";

type FacebookSdk = Awaited<ReturnType<typeof loadFacebookSdk>>;

export type FacebookSdkState =
  | { status: "unconfigured" }
  | { status: "loading" }
  | { status: "ready"; fb: FacebookSdk }
  | { status: "error" };

/**
 * Preloads the SDK on mount. FB.login has to run synchronously inside the
 * click handler (popup blockers), so the SDK must already be ready by then;
 * buttons stay disabled until it is.
 */
export function useFacebookSdk(config: MetaSdkConfig | null): FacebookSdkState {
  const [state, setState] = useState<FacebookSdkState>(
    config ? { status: "loading" } : { status: "unconfigured" },
  );
  const appId = config?.appId;
  const graphVersion = config?.graphVersion;

  useEffect(() => {
    if (!appId || !graphVersion) return;
    let cancelled = false;
    loadFacebookSdk({ appId, graphVersion })
      .then((fb) => {
        if (!cancelled) setState({ status: "ready", fb });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [appId, graphVersion]);

  return state;
}
