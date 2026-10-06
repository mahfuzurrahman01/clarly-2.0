import { getConsoleSession } from "@/lib/session";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";

export const dynamic = "force-dynamic";

/**
 * Campaigns is admin-only — the nav entry is `adminOnly` and every
 * `/campaigns` and `/segments` route is guarded on the backend. The gate is
 * mirrored here so an agent gets a sentence instead of a wall of 403 toasts.
 */
export default async function CampaignsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  if (session.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
        <PageHeader eyebrow={t.campaigns.eyebrow} title={t.campaigns.title} />
        <div className="mt-8 rounded-xl border border-border p-8">
          <p className="max-w-[60ch] text-sm text-muted-foreground">
            {t.campaigns.adminOnly}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      {children}
    </div>
  );
}
