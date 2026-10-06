"use client";

import { useState } from "react";
import { Info, Loader2, Plus, RadioTower, Timer, Unplug } from "lucide-react";
import { toast } from "sonner";
import {
  COURIERS,
  COURIER_CAPABILITIES,
  disconnectCourier,
  type Courier,
  type CourierConnection,
  type CourierConnectionResult,
} from "@/lib/api/delivery";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { CourierConnectionForm } from "./courier-connection-form";
import { CourierWebhookPanel } from "./courier-webhook-panel";
import { LtrToken } from "./ltr-token";
import { courierLabel, formatDateTimeOr } from "./format";

type FormTarget = { courier: Courier; existing: CourierConnection | null };

function CapabilityChip({ courier }: { courier: Courier }) {
  const t = useTranslations();
  const supportsWebhook = COURIER_CAPABILITIES[courier].supportsWebhook;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
      {supportsWebhook ? (
        <RadioTower className="size-3" aria-hidden />
      ) : (
        <Timer className="size-3" aria-hidden />
      )}
      {supportsWebhook
        ? t.delivery.connections.webhookVerified
        : t.delivery.connections.pollOnly}
    </span>
  );
}

function StateChip({ connection }: { connection: CourierConnection }) {
  const t = useTranslations();
  return connection.isActive ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2.5 py-0.5 text-xs text-lime-text">
      {t.delivery.connections.stateConnected}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
      {t.delivery.connections.stateInactive}
    </span>
  );
}

/**
 * Courier accounts, one block per courier rather than one card per
 * connection: which courier you are looking at is the first thing a merchant
 * needs, and three of the four behave differently enough (poll-only vs push)
 * that the capability belongs on the courier, not buried in a row.
 *
 * Nothing here can render a credential, because {@link CourierConnection}
 * has no field that could hold one.
 */
export function CourierConnectionsManager({
  initial,
}: {
  initial: CourierConnection[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [connections, setConnections] = useState(initial);
  const [target, setTarget] = useState<FormTarget | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);

  /**
   * Field-by-field rather than a spread: the create response can carry a
   * `verificationError`, which is a message about one attempt and not part of
   * a connection's state. Copying explicitly keeps it out of the list.
   */
  function upsertLocal(saved: CourierConnectionResult | CourierConnection) {
    const record: CourierConnection = {
      id: saved.id,
      courier: saved.courier,
      accountRef: saved.accountRef,
      isActive: saved.isActive,
      supportsWebhook: saved.supportsWebhook,
      hasWebhookSecret: saved.hasWebhookSecret,
      lastVerifiedAt: saved.lastVerifiedAt,
      lastPolledAt: saved.lastPolledAt,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
    setConnections((prev) => {
      const exists = prev.some((item) => item.id === record.id);
      return exists
        ? prev.map((item) => (item.id === record.id ? record : item))
        : [...prev, record];
    });
  }

  async function disconnect(connection: CourierConnection) {
    const message = t.delivery.connections.disconnectConfirmTemplate.replace(
      "{courier}",
      courierLabel(connection.courier),
    );
    if (!confirm(message)) return;
    setDisconnectingId(connection.id);
    try {
      await disconnectCourier(connection.id);
      setConnections((prev) =>
        prev.map((item) =>
          item.id === connection.id ? { ...item, isActive: false } : item,
        ),
      );
      toast.success(t.delivery.connections.disconnected);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.delivery.connections.couldNotDisconnect),
      );
    } finally {
      setDisconnectingId(null);
    }
  }

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.delivery.connections.title}
        </h2>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
          {t.delivery.connections.description}
        </p>
        <p className="flex max-w-[70ch] items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t.delivery.connections.trustNote}
        </p>
      </header>

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {COURIERS.map((courier) => {
          const rows = connections.filter((item) => item.courier === courier);
          const formOpen = target?.courier === courier;
          return (
            <div key={courier} className="space-y-4 px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <LtrToken className="font-display text-base font-medium tracking-tight">
                    {courierLabel(courier)}
                  </LtrToken>
                  <CapabilityChip courier={courier} />
                </div>
                <Button
                  variant={rows.length === 0 ? "outline" : "ghost"}
                  size="sm"
                  onClick={() => setTarget({ courier, existing: null })}
                  disabled={formOpen && target?.existing === null}
                >
                  <Plus className="size-3.5" aria-hidden />
                  {t.delivery.connections.connect}
                </Button>
              </div>

              <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
                {COURIER_CAPABILITIES[courier].supportsWebhook
                  ? t.delivery.connections.webhookVerifiedHint
                  : t.delivery.connections.pollOnlyHint}
              </p>

              {rows.length === 0 && !formOpen ? (
                <p className="text-sm text-muted-foreground">
                  {t.delivery.connections.stateNotConnected}
                </p>
              ) : null}

              {rows.map((connection) => (
                <article
                  key={connection.id}
                  className="space-y-4 rounded-lg border border-border bg-card/60 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <LtrToken className="text-sm font-medium" tabular>
                          {connection.accountRef}
                        </LtrToken>
                        <StateChip connection={connection} />
                      </div>
                      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                        <div className="flex gap-1.5">
                          <dt>{t.delivery.connections.verifiedAt}</dt>
                          <dd>
                            {formatDateTimeOr(
                              connection.lastVerifiedAt,
                              locale,
                              t.delivery.connections.neverVerified,
                            )}
                          </dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt>{t.delivery.connections.lastPolled}</dt>
                          <dd>
                            {formatDateTimeOr(
                              connection.lastPolledAt,
                              locale,
                              t.delivery.connections.neverPolled,
                            )}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTarget({ courier, existing: connection })}
                      >
                        {t.delivery.connections.reenter}
                      </Button>
                      {connection.isActive ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void disconnect(connection)}
                          disabled={disconnectingId === connection.id}
                        >
                          {disconnectingId === connection.id ? (
                            <Loader2 className="size-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Unplug className="size-3.5" aria-hidden />
                          )}
                          {t.delivery.connections.disconnect}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {connection.supportsWebhook ? (
                    <CourierWebhookPanel
                      connection={connection}
                      onRotated={upsertLocal}
                    />
                  ) : null}
                </article>
              ))}

              {formOpen && target ? (
                <div className="rounded-lg border border-border bg-card p-5">
                  <CourierConnectionForm
                    key={target.existing?.id ?? `new-${courier}`}
                    courier={courier}
                    existing={target.existing}
                    onSaved={(saved) => {
                      upsertLocal(saved);
                      if (!saved.verificationError) setTarget(null);
                    }}
                    onCancel={() => setTarget(null)}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
