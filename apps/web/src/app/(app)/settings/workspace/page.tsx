import { getConsoleSession } from "@/lib/session";
import { getTenant } from "@/lib/api/onboarding";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { WorkspaceProfileManager } from "@/components/settings/workspace-profile-manager";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const tenant = await getTenant(session.token);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.workspace.eyebrow}
        title={t.workspace.title}
        description={t.workspace.description}
      />
      <WorkspaceProfileManager initial={tenant} canEdit={session.role === "admin"} />
    </div>
  );
}
