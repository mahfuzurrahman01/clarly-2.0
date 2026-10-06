"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  type ConnectedStore,
  disconnectStore,
  listStoreConnections,
} from "@/lib/api/store";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { StoreConnectionCard } from "./store-connection-card";
import { StoreConnectPanel } from "./store-connect-panel";

export type StoreCallbackNotice =
  | { kind: "connected"; storeName: string | null }
  | { kind: "error" };

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md"
    >
      <h2 id={id} className="font-display text-lg font-medium tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * F24 console: connected-store list + the four-provider connect flow.
 * `callbackNotice` comes from the server page's `searchParams` — the
 * OAuth/key-delivery callback lands on `/stores` (hardcoded server-side) which
 * forwards here with the same query string.
 */
export function StoreSettings({
  initial,
  callbackNotice,
}: {
  initial: ConnectedStore[];
  callbackNotice: StoreCallbackNotice | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [connections, setConnections] = useState(initial);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function refresh() {
    try {
      setConnections(await listStoreConnections());
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.store.errorBody));
    }
  }

  useEffect(() => {
    if (!callbackNotice) return;
    if (callbackNotice.kind === "connected") {
      toast.success(
        callbackNotice.storeName
          ? t.store.connectedToastTemplate.replace("{store}", callbackNotice.storeName)
          : t.store.connectedToastGeneric,
      );
      // The WooCommerce key delivery is a separate server-to-server request
      // that can land slightly after the browser's own redirect here — a
      // one-shot refresh picks it up without polling.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    } else {
      toast.error(t.store.oauthFailedToast);
    }
    // Only ever meant to fire once, for the query string this page loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(connection: ConnectedStore) {
    if (!confirm(t.store.disconnectConfirmTemplate.replace("{name}", connection.storeName))) {
      return;
    }
    setRemovingId(connection.id);
    try {
      await disconnectStore(connection.id);
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
      toast.success(t.store.disconnectedToast);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.store.couldNotDisconnect));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Section
        id="store-connections"
        title={t.store.connectedTitle}
        description={t.store.connectedDescription}
      >
        {connections.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            {t.store.noConnections}
          </p>
        ) : (
          <ul className="space-y-3">
            {connections.map((connection) => (
              <li key={connection.id}>
                <StoreConnectionCard
                  connection={connection}
                  locale={locale}
                  onDisconnect={remove}
                  disconnecting={removingId === connection.id}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        id="store-connect"
        title={t.store.connectSectionTitle}
        description={t.store.connectSectionDescription}
      >
        <StoreConnectPanel />
      </Section>
    </div>
  );
}
