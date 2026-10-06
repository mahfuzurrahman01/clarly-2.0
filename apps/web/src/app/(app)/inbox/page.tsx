import { getConsoleSession } from "@/lib/session";
import { listConversations } from "@/lib/api/inbox";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { InboxList } from "@/components/inbox/inbox-list";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const initial = await listConversations({ limit: 25 }, session.token);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.inbox.eyebrow}
        title={t.inbox.title}
        description={t.inbox.description}
      />
      <div className="mt-8">
        <InboxList initial={initial} />
      </div>
    </div>
  );
}
