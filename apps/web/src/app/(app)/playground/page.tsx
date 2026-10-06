import Link from "next/link";
import { getConsoleSession } from "@/lib/session";
import { listAgents } from "@/lib/api/agents";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { Playground } from "@/components/playground/playground";
import { DevSimulatorPanel } from "@/components/playground/dev-simulator-panel";
import { Button } from "@/components/ui/button";

const simulatorEnabled =
  process.env.NODE_ENV !== "production" &&
  process.env.DEV_SIMULATOR_ENABLED === "true";

export const dynamic = "force-dynamic";

export default async function PlaygroundPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  // Mirror the API guard: /agents is admin-only. Agents get a clean message,
  // not a 403 crash — the real boundary is still the backend.
  if (session.role !== "admin") {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
        <PageHeader eyebrow={t.playground.eyebrow} title={t.playground.title} />
        <div className="mt-8 rounded-xl border border-border p-8">
          <p className="text-sm text-muted-foreground">
            {t.playground.adminOnly}
          </p>
        </div>
      </div>
    );
  }

  const agents = await listAgents(session.token);

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.playground.eyebrow}
        title={t.playground.title}
        description={t.playground.description}
      />
      <div className="mt-8">
        {agents.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border p-8">
            <h2 className="font-display text-xl font-medium tracking-tight">
              {t.playground.noAgentTitle}
            </h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              {t.playground.noAgentBody}
            </p>
            <Button render={<Link href="/settings" />} variant="outline" size="sm">
              {t.playground.goToSettings}
            </Button>
          </div>
        ) : (
          <Playground agents={agents} />
        )}
        {simulatorEnabled && <DevSimulatorPanel />}
      </div>
    </div>
  );
}
