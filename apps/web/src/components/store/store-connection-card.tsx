"use client";

import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import type { ConnectedStore } from "@/lib/api/store";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StoreProviderBadge } from "./store-provider-badge";

function formatTimestamp(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * One connected store. `lastSyncedAt` (last SUCCESSFUL sync) and `lastSync`
 * (last ATTEMPT, may have failed) answer different questions and are both
 * rendered — a connection can be `isActive` with a healthy `lastSyncedAt`
 * while its most recent attempt failed, and that distinction matters to a
 * merchant deciding whether their catalog is stale.
 */
export function StoreConnectionCard({
  connection,
  locale,
  onDisconnect,
  disconnecting,
}: {
  connection: ConnectedStore;
  locale: string;
  onDisconnect: (connection: ConnectedStore) => void;
  disconnecting: boolean;
}) {
  const t = useTranslations();
  const lastSyncedAt = formatTimestamp(connection.lastSyncedAt, locale);
  const lastSync = connection.lastSync;
  const lastAttemptFailed = lastSync?.status === "failed";

  return (
    <article
      className="space-y-3 rounded-lg border border-border p-4"
      aria-label={connection.storeName}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StoreProviderBadge provider={connection.provider} />
        <span className="truncate font-medium">{connection.storeName}</span>
        {connection.storeUrl ? (
          <span className="truncate text-xs text-muted-foreground">
            {connection.storeUrl}
          </span>
        ) : null}
        <span
          className={cn(
            "ms-auto rounded-full border px-2 py-0.5 text-xs",
            connection.isActive
              ? "border-lime-ring/40 bg-lime-soft/70 text-lime-text"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {connection.isActive ? t.store.statusActive : t.store.statusInactive}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onDisconnect(connection)}
          disabled={disconnecting}
          aria-label={`${t.store.disconnect}: ${connection.storeName}`}
        >
          {disconnecting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
        </Button>
      </div>

      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t.store.lastSyncedLabel}</dt>
          <dd>{lastSyncedAt ?? t.store.neverSynced}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t.store.lastAttemptLabel}</dt>
          <dd>
            {lastSync
              ? t.store.syncCountsTemplate
                  .replace("{status}", syncStatusLabel(lastSync.status, t))
                  .replace("{synced}", String(lastSync.productsSynced))
                  .replace("{failed}", String(lastSync.productsFailed))
              : t.store.noSyncAttempt}
          </dd>
        </div>
      </dl>

      {lastAttemptFailed && lastSync?.errorMessage ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {lastSync.errorMessage}
        </div>
      ) : null}
    </article>
  );
}

function syncStatusLabel(status: string, t: Dictionary): string {
  switch (status) {
    case "pending":
      return t.store.syncStatusPending;
    case "running":
      return t.store.syncStatusRunning;
    case "completed":
      return t.store.syncStatusCompleted;
    case "failed":
      return t.store.syncStatusFailed;
    default:
      return status;
  }
}
