import { getConsoleSession } from "@/lib/session";
import {
  ORDERS_PAGE_SIZE,
  getOrderSettings,
  listOrders,
  type OrderSettings,
} from "@/lib/api/orders";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getServerNow } from "@/lib/time";
import { PageHeader } from "@/components/shell/page-header";
import { OrdersManager } from "@/components/orders/orders-manager";

export const dynamic = "force-dynamic";

/**
 * F25 orders console. `/orders/settings` is admin-only and 403s an agent
 * token, so the settings read is skipped entirely for a non-admin rather than
 * burning a round trip on a guaranteed 403 — the panel still renders, with an
 * explanation instead of a form.
 */
async function loadSettings(
  role: string | null,
  token: string,
): Promise<OrderSettings | null> {
  if (role !== "admin") return null;
  try {
    return await getOrderSettings(token);
  } catch {
    // The queue and the list are still useful without the mode switch, so a
    // settings failure degrades the panel rather than the page.
    return null;
  }
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; conversationId?: string }>;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const { customerId, conversationId } = await searchParams;

  const [queue, all, settings] = await Promise.all([
    listOrders(
      { status: "pending_approval", limit: ORDERS_PAGE_SIZE },
      session.token,
    ),
    listOrders(
      { customerId, conversationId, limit: ORDERS_PAGE_SIZE },
      session.token,
    ),
    loadSettings(session.role, session.token),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.orders.eyebrow}
        title={t.orders.title}
        description={t.orders.description}
      />
      <div className="mt-8">
        <OrdersManager
          queue={queue}
          all={all}
          settings={settings}
          canManage={session.role === "admin"}
          settingsError={
            settings === null && session.role === "admin"
              ? t.orders.settings.couldNotLoad
              : null
          }
          now={getServerNow()}
          customerId={customerId}
          conversationId={conversationId}
        />
      </div>
    </div>
  );
}
