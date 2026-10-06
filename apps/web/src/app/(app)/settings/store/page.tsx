import { getConsoleSession } from "@/lib/session";
import { ApiError } from "@/lib/api/client";
import { type ConnectedStore, listStoreConnections } from "@/lib/api/store";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { StoreSettings } from "@/components/store/store-settings";

export const dynamic = "force-dynamic";

/**
 * A lapsed workspace gets 403 from EntitlementGuard on the store routes; show
 * the page (its connect buttons then surface the upgrade dialog) instead of
 * the error screen. Anything else is a real failure. Same pattern as
 * settings/channels.
 */
function emptyOnForbidden(err: unknown): ConnectedStore[] {
  if (err instanceof ApiError && err.status === 403) return [];
  throw err;
}

export default async function StoreSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string; store?: string }>;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const { connected, error, store } = await searchParams;
  const connections = await listStoreConnections(session.token).catch(emptyOnForbidden);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.store.eyebrow}
        title={t.store.title}
        description={t.store.description}
      />
      <StoreSettings
        initial={connections}
        callbackNotice={
          connected === "true"
            ? { kind: "connected", storeName: store ?? null }
            : error === "oauth_failed"
              ? { kind: "error" }
              : null
        }
      />
    </div>
  );
}
