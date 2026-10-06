import { getConsoleSession } from "@/lib/session";
import { listTeam } from "@/lib/api/team";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { TeamManager } from "@/components/settings/team-manager";

export const dynamic = "force-dynamic";

export default async function TeamSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const members = await listTeam(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.settings.eyebrow}
        title={t.team.title}
        description={t.team.description}
      />
      <TeamManager initial={members} currentUserId={session.userId} />
    </div>
  );
}
