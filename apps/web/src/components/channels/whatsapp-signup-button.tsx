"use client";

import { useState } from "react";
import { Loader2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { MetaSdkConfig } from "@/lib/env";
import {
  type EmbeddedSignupResult,
  completeEmbeddedSignup,
} from "@/lib/api/whatsapp-connect";
import { embeddedSignupErrorCopy } from "@/lib/channels/connect-errors";
import { type EmbeddedSignupOutcome, runEmbeddedSignup } from "@/lib/meta/embedded-signup";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import type { FacebookSdkState } from "./use-facebook-sdk";

type Props = {
  config: MetaSdkConfig | null;
  sdk: FacebookSdkState;
  /** WhatsApp Business app number (coexistence, D13). */
  coexistence?: boolean;
  /** Existing two-step PIN for the D15c retry; validated by the caller. */
  pin?: string;
  label: string;
  variant?: "default" | "outline";
  size?: "default" | "sm";
  icon?: "plus" | "retry";
  disabled?: boolean;
  onConnected: (result: EmbeddedSignupResult) => void;
};

/**
 * Opens Meta's WhatsApp Embedded Signup popup and completes the connect on
 * our API. The `code` goes straight from the popup to the POST and is never
 * stored or logged (single use, ~30 s TTL).
 */
export function WhatsappSignupButton({
  config,
  sdk,
  coexistence = false,
  pin,
  label,
  variant = "default",
  size = "default",
  icon = "plus",
  disabled,
  onConnected,
}: Props) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const configId = config?.embeddedSignupConfigId ?? null;
  const ready = sdk.status === "ready" && configId !== null;

  function reportOutcome(outcome: Exclude<EmbeddedSignupOutcome, { status: "completed" }>) {
    const c = t.channels;
    switch (outcome.status) {
      case "cancelled":
        toast.info(
          outcome.currentStep
            ? c.signupCancelledAtStepTemplate.replace("{step}", outcome.currentStep)
            : c.signupCancelled,
        );
        return;
      case "error":
        toast.error(c.signupErrorTemplate.replace("{message}", outcome.errorMessage));
        return;
      case "missing_session":
        toast.error(c.signupMissingSession);
        return;
    }
  }

  async function finish(outcome: EmbeddedSignupOutcome) {
    if (outcome.status !== "completed") {
      reportOutcome(outcome);
      return;
    }
    try {
      const result = await completeEmbeddedSignup({
        code: outcome.code,
        wabaId: outcome.wabaId,
        ...(outcome.phoneNumberId ? { phoneNumberId: outcome.phoneNumberId } : {}),
        ...(pin ? { pin } : {}),
      });
      if (result.connectionState === "active") {
        toast.success(result.coexistence ? t.channels.connectedCoexistence : t.channels.connected);
      } else {
        toast.warning(t.channels.connectedNeedsAction, {
          description: result.connectionError ?? undefined,
        });
      }
      onConnected(result);
    } catch (err) {
      const copy = embeddedSignupErrorCopy(err, t);
      toast.error(copy.message, { description: copy.detail });
    }
  }

  function launch() {
    if (sdk.status !== "ready" || !configId || busy) return;
    setBusy(true);
    // Synchronous from the click: FB.login opens the popup right here.
    runEmbeddedSignup(sdk.fb, { configId, coexistence })
      .then(finish)
      .catch(() => toast.error(t.channels.couldNotConnect))
      .finally(() => setBusy(false));
  }

  const Icon = icon === "retry" ? RefreshCw : Plus;
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={launch}
      disabled={!ready || busy || disabled}
      aria-busy={busy}
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {busy ? t.channels.connecting : label}
    </Button>
  );
}
