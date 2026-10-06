import { headers } from "next/headers";
import { getConsoleSession } from "@/lib/session";
import { getWidget } from "@/lib/api/widget";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { WebsiteChatManager } from "@/components/settings/website-chat-manager";

export const dynamic = "force-dynamic";

/** The console's own public origin, for the `<script src>` of the embed snippet. */
async function consoleOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export default async function WebsiteChatPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const widget = await getWidget(session.token);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t.widget.eyebrow} title={t.widget.title} description={t.widget.description} />
      <WebsiteChatManager
        initial={widget}
        canEdit={session.role === "admin"}
        consoleOrigin={await consoleOrigin()}
      />
    </div>
  );
}
