"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { MetaSdkConfig } from "@/lib/env";
import {
  type SocialChannel,
  type SocialHandshake,
  disconnectSocialChannel,
  listSocialChannels,
  startSocialHandshake,
} from "@/lib/api/social-channels";
import { apiErrorMessage } from "@/lib/api/error-message";
import { socialHandshakeErrorCopy } from "@/lib/channels/connect-errors";
import { facebookLogin } from "@/lib/meta/facebook-sdk";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChannelBadge } from "./channel-badge";
import { PagePickerDialog } from "./page-picker-dialog";
import { SdkStatusNote } from "./sdk-status-note";
import type { FacebookSdkState } from "./use-facebook-sdk";

/**
 * Facebook Login for Business → server handshake (Gulf T4) → page picker.
 * The only token the browser touches is the short-lived *user* token, and
 * only long enough to POST it; page tokens never reach the browser.
 */
export function SocialChannelsPanel({
  initial,
  config,
  sdk,
}: {
  initial: SocialChannel[];
  config: MetaSdkConfig | null;
  sdk: FacebookSdkState;
}) {
  const t = useTranslations();
  const [channels, setChannels] = useState(initial);
  const [handshake, setHandshake] = useState<SocialHandshake | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const loginConfigId = config?.loginConfigId ?? null;
  const ready = sdk.status === "ready" && loginConfigId !== null;

  async function refresh() {
    try {
      setChannels(await listSocialChannels());
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.channels.errorBody));
    }
  }

  async function exchange(userAccessToken: string) {
    try {
      setHandshake(await startSocialHandshake(userAccessToken));
    } catch (err) {
      const copy = socialHandshakeErrorCopy(err, t);
      toast.error(copy.message, { description: copy.detail });
    }
  }

  function connectWithFacebook() {
    if (sdk.status !== "ready" || !loginConfigId || loggingIn) return;
    setLoggingIn(true);
    // Synchronous from the click so the popup isn't blocked.
    facebookLogin(sdk.fb, { config_id: loginConfigId })
      .then(async (response) => {
        const token = response.authResponse?.accessToken;
        if (!token) {
          toast.info(t.channels.loginCancelled);
          return;
        }
        await exchange(token);
      })
      .catch(() => toast.error(t.channels.couldNotLoadPages))
      .finally(() => setLoggingIn(false));
  }

  async function remove(channel: SocialChannel) {
    const name = channel.displayName ?? channel.channelAccountId;
    if (!confirm(t.channels.disconnectConfirmTemplate.replace("{name}", name))) return;
    setRemovingId(channel.id);
    try {
      await disconnectSocialChannel(channel.id);
      setChannels((prev) => prev.filter((c) => c.id !== channel.id));
      toast.success(t.channels.disconnectedToast);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.channels.couldNotDisconnect));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Button
          type="button"
          onClick={connectWithFacebook}
          disabled={!ready || loggingIn}
          aria-busy={loggingIn}
        >
          {loggingIn ? <Loader2 className="size-4 animate-spin" /> : null}
          {t.channels.connectFacebook}
        </Button>
        <SdkStatusNote sdk={sdk} configured={loginConfigId !== null} />
      </div>

      {channels.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t.channels.noSocialChannels}
        </p>
      ) : (
        <ul className="space-y-3">
          {channels.map((c) => {
            const needsReconnect = c.connectionState === "reconnect_required";
            return (
              <li key={c.id}>
                <article
                  className="space-y-3 rounded-lg border border-border p-4"
                  aria-label={c.displayName ?? c.channelAccountId}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ChannelBadge channel={c.channel} />
                    <span className="truncate font-medium">
                      {c.displayName ?? c.channelAccountId}
                    </span>
                    <span
                      className={cn(
                        "ms-auto rounded-full border px-2 py-0.5 text-xs",
                        needsReconnect
                          ? "border-destructive/40 bg-destructive/5 text-destructive"
                          : "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
                      )}
                    >
                      {needsReconnect
                        ? t.channels.stateReconnectRequired
                        : t.channels.socialStateConnected}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => remove(c)}
                      disabled={removingId === c.id}
                      aria-label={`${t.channels.disconnect}: ${c.displayName ?? c.channelAccountId}`}
                    >
                      {removingId === c.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </div>
                  {needsReconnect ? (
                    <div
                      role="status"
                      className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
                    >
                      <p className="flex flex-1 items-start gap-2 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        {c.connectionError ?? t.channels.reconnectGeneric}
                      </p>
                      {/* Reconnect = the same Facebook Login + same page (T4 step 6). */}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={connectWithFacebook}
                        disabled={!ready || loggingIn}
                      >
                        <RefreshCw className="size-3.5" />
                        {t.channels.reconnect}
                      </Button>
                    </div>
                  ) : null}
                </article>
              </li>
            );
          })}
        </ul>
      )}

      <PagePickerDialog
        handshake={handshake}
        connected={channels}
        onClose={() => setHandshake(null)}
        onConnected={refresh}
      />
    </div>
  );
}
