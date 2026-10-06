"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/i18n/provider";
import type { FacebookSdkState } from "./use-facebook-sdk";

/**
 * Why a Meta connect button is disabled, if it is. `configured` is false
 * when this flow's own Login-for-Business configuration id is missing.
 */
export function SdkStatusNote({
  sdk,
  configured,
}: {
  sdk: FacebookSdkState;
  configured: boolean;
}) {
  const t = useTranslations();
  if (sdk.status === "unconfigured" || !configured) {
    return <p className="text-sm text-muted-foreground">{t.channels.notConfigured}</p>;
  }
  if (sdk.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        {t.channels.sdkLoading}
      </p>
    );
  }
  if (sdk.status === "error") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {t.channels.sdkFailed}
      </p>
    );
  }
  return null;
}
