"use client";

import { useState } from "react";
import { Check, Copy, Loader2, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";
import {
  courierWebhookUrl,
  rotateWebhookSecret,
  type CourierConnection,
} from "@/lib/api/delivery";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { LtrToken } from "./ltr-token";

/**
 * The push-callback half of a connection. Rendered **only** for a courier
 * that has one — `POST /couriers/connections/:id/webhook-secret` 404s for
 * Aramex, SMSA and Naqel, and showing a merchant a callback URL that no
 * courier will ever call is worse than showing nothing.
 *
 * The secret follows the same write-only rule as the credentials, with one
 * difference: this one we mint, so it is legible exactly once, in the
 * response to the rotate call. There is no "show it again".
 */
export function CourierWebhookPanel({
  connection,
  onRotated,
}: {
  connection: CourierConnection;
  onRotated: (connection: CourierConnection) => void;
}) {
  const t = useTranslations();
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);

  const url = courierWebhookUrl(connection.courier, connection.accountRef);

  async function copy(value: string, which: "url" | "secret") {
    await navigator.clipboard.writeText(value);
    setCopied(which);
    setTimeout(() => setCopied(null), 2000);
  }

  async function rotate() {
    if (connection.hasWebhookSecret && !confirm(t.delivery.webhook.rotateConfirm)) {
      return;
    }
    setRotating(true);
    try {
      const result = await rotateWebhookSecret(connection.id);
      setSecret(result.webhookSecret);
      onRotated({ ...connection, hasWebhookSecret: true });
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.delivery.webhook.couldNotRotate));
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-secondary/30 p-4">
      <div className="space-y-1">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Webhook className="size-4 text-muted-foreground" aria-hidden />
          {t.delivery.webhook.title}
        </h4>
        <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
          {t.delivery.webhook.description}
        </p>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          {t.delivery.webhook.urlLabel}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <LtrToken className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
            {url}
          </LtrToken>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy(url, "url")}
          >
            {copied === "url" ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
            {copied === "url"
              ? t.delivery.webhook.copied
              : t.delivery.webhook.copyUrl}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span
          className={
            connection.hasWebhookSecret
              ? "inline-flex items-center gap-1.5 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2.5 py-0.5 text-xs text-lime-text"
              : "inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground"
          }
        >
          {connection.hasWebhookSecret
            ? t.delivery.webhook.secretSet
            : t.delivery.webhook.secretMissing}
        </span>
        <Button
          type="button"
          variant={connection.hasWebhookSecret ? "ghost" : "outline"}
          size="sm"
          onClick={() => void rotate()}
          disabled={rotating}
        >
          {rotating ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          {rotating
            ? t.delivery.webhook.rotating
            : connection.hasWebhookSecret
              ? t.delivery.webhook.rotate
              : t.delivery.webhook.generate}
        </Button>
      </div>

      {secret ? (
        <div className="space-y-3 rounded-lg border border-lime-ring/40 bg-lime-soft/40 p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium text-lime-text">
              {t.delivery.webhook.revealTitle}
            </p>
            <p className="max-w-[65ch] text-xs leading-relaxed text-lime-text/80">
              {t.delivery.webhook.revealBody}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LtrToken className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
              {secret}
            </LtrToken>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copy(secret, "secret")}
            >
              {copied === "secret" ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              {copied === "secret"
                ? t.delivery.webhook.copied
                : t.delivery.webhook.copyUrl}
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSecret(null)}
          >
            {t.delivery.webhook.dismiss}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
