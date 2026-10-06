"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Trash2, Webhook } from "lucide-react";
import { toast } from "sonner";
import {
  WEBHOOK_EVENTS,
  type TenantWebhookCreated,
  type TenantWebhookRecord,
  type WebhookEvent,
  createWebhook,
  deleteWebhook,
} from "@/lib/api/outbound-webhooks";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { isolate } from "@/lib/i18n/template";
import {
  type EndpointUrlProblem,
  endpointUrlProblem,
} from "@/lib/webhooks/endpoint-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function eventLabel(
  t: ReturnType<typeof useTranslations>,
  event: WebhookEvent,
): string {
  const MAP: Record<WebhookEvent, string> = {
    "conversation.intake_captured": t.webhooks.eventIntakeCaptured,
    "ticket.created": t.webhooks.eventTicketCreated,
    "ticket.resolved": t.webhooks.eventTicketResolved,
  };
  return MAP[event];
}

function SecretReveal({
  created,
  onDismiss,
}: {
  created: TenantWebhookCreated;
  onDismiss: () => void;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(created.secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3 rounded-xl border border-lime-ring/40 bg-lime-soft/40 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-lime-text" />
        <p className="text-sm font-medium text-lime-text">{t.webhooks.secretWarning}</p>
      </div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-card px-3 py-2 font-mono text-xs">
          {created.secret}
        </code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? t.webhooks.copied : t.webhooks.copy}
        </Button>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
        {t.webhooks.secretDismiss}
      </Button>
    </div>
  );
}

export function OutboundWebhooksManager({
  initial,
}: {
  initial: TenantWebhookRecord[];
}) {
  const t = useTranslations();
  const [webhooks, setWebhooks] = useState(initial);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<TenantWebhookCreated | null>(null);
  // Only nag once the field has been left (or a submit was tried), not on every keystroke.
  const [urlTouched, setUrlTouched] = useState(false);

  const urlProblem = url.trim() ? endpointUrlProblem(url) : null;
  const showUrlProblem = urlTouched && urlProblem !== null;
  const URL_PROBLEM_MESSAGES: Record<EndpointUrlProblem, string> = {
    invalid: t.webhooks.urlInvalid,
    https: t.webhooks.urlHttpsRequired,
    private: t.webhooks.urlPrivateHost,
  };

  function toggleEvent(event: WebhookEvent) {
    setEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (urlProblem) {
      setUrlTouched(true);
      return;
    }
    if (!trimmed || events.length === 0 || creating) return;
    setCreating(true);
    try {
      const created = await createWebhook(trimmed, events);
      const { secret, ...record } = created;
      setWebhooks((prev) => [record, ...prev]);
      setRevealed(created);
      setUrl("");
      setUrlTouched(false);
      setEvents([]);
      toast.success(t.webhooks.created);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.webhooks.couldNotCreate),
      );
    } finally {
      setCreating(false);
    }
  }

  async function remove(webhook: TenantWebhookRecord) {
    if (!confirm(t.webhooks.removeConfirmTemplate.replace("{url}", webhook.url))) {
      return;
    }
    setBusyId(webhook.id);
    try {
      await deleteWebhook(webhook.id);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhook.id));
      toast.success(t.webhooks.removed);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.webhooks.couldNotRemove),
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.webhooks.createTitle}
        </h2>
        <form onSubmit={create} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="webhook-url">
              {t.webhooks.urlLabel}
            </label>
            <Input
              id="webhook-url"
              type="url"
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setUrlTouched(true)}
              placeholder="https://example.com/webhooks/clarly"
              aria-invalid={showUrlProblem ? true : undefined}
              aria-describedby={showUrlProblem ? "webhook-url-error" : undefined}
            />
            {showUrlProblem && urlProblem ? (
              <p id="webhook-url-error" className="text-xs text-destructive">
                {URL_PROBLEM_MESSAGES[urlProblem]}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t.webhooks.eventsLabel}</p>
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((event) => {
                const checked = events.includes(event);
                return (
                  <button
                    type="button"
                    key={event}
                    onClick={() => toggleEvent(event)}
                    aria-pressed={checked}
                    className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      checked
                        ? "border-lime-ring/40 bg-lime-soft/70 text-lime-text"
                        : "border-border bg-secondary text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {eventLabel(t, event)}
                  </button>
                );
              })}
            </div>
          </div>
          <Button
            type="submit"
            disabled={creating || !url.trim() || urlProblem !== null || events.length === 0}
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Webhook className="size-4" />
            )}
            {t.webhooks.createButton}
          </Button>
        </form>
      </section>

      {revealed ? (
        <SecretReveal created={revealed} onDismiss={() => setRevealed(null)} />
      ) : null}

      {webhooks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.webhooks.empty}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {webhooks.map((webhook) => {
            const busy = busyId === webhook.id;
            return (
              <li key={webhook.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-1">
                  {/* A URL is LTR whatever the page is: as an LTR block the
                      ellipsis lands on its tail (the path), never on the
                      scheme and host that identify it. `rtl:text-right`
                      keeps a short URL flush with the Arabic column. */}
                  <p
                    dir="ltr"
                    title={webhook.url}
                    className="truncate text-start text-sm font-medium rtl:text-right"
                  >
                    {webhook.url}
                  </p>
                  <p className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    {webhook.events.map((event) => (
                      <span
                        key={event}
                        className="rounded-full border border-border bg-secondary px-2 py-0.5"
                      >
                        {eventLabel(t, event)}
                      </span>
                    ))}
                  </p>
                  {webhook.lastFailureAt ? (
                    <p className="flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle className="size-3" />
                      {t.webhooks.lastFailureTemplate.replace(
                        "{time}",
                        isolate(new Date(webhook.lastFailureAt).toLocaleString()),
                      )}
                      {webhook.lastFailureReason ? ` — ${isolate(webhook.lastFailureReason)}` : ""}
                    </p>
                  ) : webhook.lastSuccessAt ? (
                    <p className="text-xs text-muted-foreground">
                      {t.webhooks.lastSuccessTemplate.replace(
                        "{time}",
                        isolate(new Date(webhook.lastSuccessAt).toLocaleString()),
                      )}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t.webhooks.noDeliveriesYet}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(webhook)}
                  disabled={busy}
                  aria-label={t.webhooks.remove}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
