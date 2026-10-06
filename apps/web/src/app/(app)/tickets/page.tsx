import { getConsoleSession } from "@/lib/session";
import { getBoardConfig, getTeam, listTickets } from "@/lib/api/kanban";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { TicketsBoard } from "@/components/tickets/tickets-board";
import { getServerNow } from "@/lib/time";

export const dynamic = "force-dynamic";

export default async function TicketsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  const [tickets, config, team] = await Promise.all([
    listTickets("all", session.token),
    getBoardConfig(session.token),
    // Empty picker is fine (provider=none); the board still works.
    getTeam(session.token).catch(() => []),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.tickets.eyebrow}
        title={t.tickets.title}
        description={t.tickets.description}
      />
      <div className="mt-8">
        <TicketsBoard
          initialTickets={tickets}
          config={config}
          team={team}
          currentUserId={session.userId}
          now={getServerNow()}
        />
      </div>
    </div>
  );
}
