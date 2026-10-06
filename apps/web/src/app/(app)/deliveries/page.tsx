import { getConsoleSession } from "@/lib/session";
import {
  ORDER_STATUSES,
  loadShipmentPage,
  type OrderStatus,
} from "@/lib/api/delivery";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { ShipmentsExplorer } from "@/components/delivery/shipments-explorer";

export const dynamic = "force-dynamic";

function parseOrderStatus(raw: string | undefined): OrderStatus | "all" {
  return raw && (ORDER_STATUSES as readonly string[]).includes(raw)
    ? (raw as OrderStatus)
    : "all";
}

/**
 * F26's shipment view. Agent-visible on purpose: "where is my customer's
 * parcel" is front-line work, and `GET /orders/:orderId/shipments` asks for
 * nothing more than a tenant token.
 *
 * The first page is assembled server-side so the list is on screen before any
 * client JavaScript runs; everything after that (filters, paging, expanding a
 * shipment) goes through the browser client.
 */
export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const orderStatus = parseOrderStatus((await searchParams).status);

  const initial = await loadShipmentPage(
    { status: orderStatus === "all" ? undefined : orderStatus },
    session.token,
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.delivery.eyebrow}
        title={t.delivery.title}
        description={t.delivery.description}
      />
      <div className="mt-8">
        <ShipmentsExplorer initial={initial} initialOrderStatus={orderStatus} />
      </div>
    </div>
  );
}
