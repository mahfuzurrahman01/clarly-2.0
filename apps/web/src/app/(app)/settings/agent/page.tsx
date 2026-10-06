import { getConsoleSession } from "@/lib/session";
import { listAgents, listNumbers } from "@/lib/api/agents";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { AgentSettings } from "@/components/settings/agent-settings";

export const dynamic = "force-dynamic";

export default async function AgentSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const [agents, numbers] = await Promise.all([
    listAgents(session.token),
    // Numbers may be unconfigured for a workspace — don't fail the page over it.
    listNumbers(session.token).catch(() => []),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.settings.eyebrow}
        title={t.settings.tabAgent}
        description={t.settings.agentPageDescription}
      />
      <AgentSettings agents={agents} numbers={numbers} />
    </div>
  );
}
