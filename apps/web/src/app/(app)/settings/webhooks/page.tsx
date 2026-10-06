import { getConsoleSession } from "@/lib/session";
import { listWebhooks } from "@/lib/api/outbound-webhooks";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { OutboundWebhooksManager } from "@/components/settings/outbound-webhooks-manager";

export const dynamic = "force-dynamic";

export default async function WebhooksSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const webhooks = await listWebhooks(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.webhooks.eyebrow}
        title={t.webhooks.title}
        description={t.webhooks.description}
      />
      <OutboundWebhooksManager initial={webhooks} />
    </div>
  );
}
