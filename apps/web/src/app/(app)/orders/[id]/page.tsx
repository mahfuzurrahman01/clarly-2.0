import { notFound } from "next/navigation";
import { getConsoleSession } from "@/lib/session";
import { getOrder, type OrderDetailResult } from "@/lib/api/orders";
import { ApiError } from "@/lib/api/client";
import { OrderDetail } from "@/components/orders/order-detail";
import {
  loadOrderShipments,
  type OrderShipmentsData,
} from "@/lib/api/delivery";

export const dynamic = "force-dynamic";

/**
 * A cross-tenant id and a nonexistent id both come back 404 by design, so
 * there is nothing to distinguish here — both are "not found".
 */
async function loadOrder(
  id: string,
  token: string,
): Promise<OrderDetailResult | null> {
  try {
    return await getOrder(id, token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The shipment card is secondary to the order itself, so its read failing
 * must not 500 the page — the card renders a retry instead.
 */
async function loadShipmentsSafe(
  id: string,
  token: string,
): Promise<OrderShipmentsData | null> {
  try {
    return await loadOrderShipments(id, token);
  } catch {
    return null;
  }
}

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getConsoleSession();
  const [data, shipments] = await Promise.all([
    loadOrder(id, session.token),
    loadShipmentsSafe(id, session.token),
  ]);

  if (!data) notFound();

  return (
    <OrderDetail
      initialOrder={data.order}
      items={data.items}
      shipments={shipments}
    />
  );
}
