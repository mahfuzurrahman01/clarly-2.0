import { getConsoleSession } from "@/lib/session";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";

export const dynamic = "force-dynamic";

// Each settings section (Agent, Knowledge base, Team) is its own screen,
// linked directly from the sidebar's collapsible Settings group — no shared
// tab switcher here. This layout only carries the outer container and the
// admin gate (every settings surface 403s for the agent role on the
// backend; mirrored here so agents get a clean message instead).
export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  if (session.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
        <PageHeader eyebrow={t.settings.eyebrow} title={t.settings.title} />
        <div className="mt-8 rounded-xl border border-border p-8">
          <p className="text-sm text-muted-foreground">
            {t.settings.adminOnly}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">{children}</div>
  );
}
