"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  approveOrder,
  cancelOrder,
  getOrder,
  isConflict,
  rejectOrder,
  retryStorePush,
  type OrderView,
} from "@/lib/api/orders";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { fill } from "./format";

/** Which button on a given row is mid-flight, so only that one spins. */
export type PendingAction =
  | { id: string; action: "approve" | "reject" | "cancel" | "retry" }
  | null;

/**
 * The four order transitions, with the one piece of behaviour every caller
 * must get right: **409 is not an error**.
 *
 * `POST /orders/:id/approve` returns 409 for two genuinely different reasons
 * and the console has to tell them apart, because the fix differs:
 *
 *  1. The order is no longer `pending_approval` — a colleague approved or
 *     rejected it a second ago, or the expiry sweep took it. Nobody did
 *     anything wrong: refresh the row and say so, calmly.
 *  2. An item went out of stock since the customer ordered. The order *is*
 *     still pending and the merchant has real work to do; the API message
 *     names the item, so it is shown.
 *
 * Re-reading the order settles which one it was — the status the server
 * reports after the failure is the answer, not a guess from the message text.
 * `cancel` and `retry-store-push` share the same shape (the state moved under
 * you), minus the stock branch.
 */
export function useOrderActions(onUpdated: (order: OrderView) => void) {
  const t = useTranslations();
  const [pending, setPending] = useState<PendingAction>(null);

  const refresh = useCallback(
    async (id: string): Promise<OrderView | null> => {
      try {
        const { order } = await getOrder(id);
        onUpdated(order);
        return order;
      } catch {
        // The refresh is best-effort: the transition already failed and the
        // user is about to be told why. A second failure isn't a second toast.
        return null;
      }
    },
    [onUpdated],
  );

  const announceAlreadyDecided = useCallback(
    (order: OrderView) => {
      toast.info(t.orders.actions.alreadyDecidedTitle, {
        description: fill(t.orders.actions.alreadyDecidedTemplate, {
          reference: order.reference,
          status: t.orders.status[order.status],
        }),
      });
    },
    [t],
  );

  const decide = useCallback(
    async (
      order: OrderView,
      action: "approve" | "reject",
      run: () => Promise<OrderView>,
    ): Promise<boolean> => {
      setPending({ id: order.id, action });
      try {
        const updated = await run();
        onUpdated(updated);
        if (action === "reject") {
          toast.success(
            fill(t.orders.actions.rejectedTemplate, {
              reference: updated.reference,
            }),
          );
        } else if (updated.customerNotifiedAt) {
          toast.success(
            fill(t.orders.actions.approvedTemplate, {
              reference: updated.reference,
            }),
          );
        } else {
          // Confirmed on our side, but the 24h window was shut: the merchant
          // has to reach the customer another way and needs to know now.
          toast.warning(
            fill(t.orders.actions.approvedNotNotifiedTemplate, {
              reference: updated.reference,
            }),
            { description: t.orders.list.notNotifiedHint },
          );
        }
        return true;
      } catch (err) {
        if (isConflict(err)) {
          const fresh = await refresh(order.id);
          if (fresh && fresh.status !== "pending_approval") {
            announceAlreadyDecided(fresh);
          } else {
            toast.warning(t.orders.actions.stockConflictTitle, {
              description: apiErrorMessage(err, t, t.orders.actions.outOfSync),
            });
          }
          return false;
        }
        toast.error(
          apiErrorMessage(
            err,
            t,
            action === "approve"
              ? t.orders.actions.couldNotApprove
              : t.orders.actions.couldNotReject,
          ),
        );
        return false;
      } finally {
        setPending(null);
      }
    },
    [announceAlreadyDecided, onUpdated, refresh, t],
  );

  const approve = useCallback(
    (order: OrderView) => decide(order, "approve", () => approveOrder(order.id)),
    [decide],
  );

  const reject = useCallback(
    (order: OrderView, reason: string) =>
      decide(order, "reject", () => rejectOrder(order.id, reason)),
    [decide],
  );

  const cancel = useCallback(
    async (order: OrderView) => {
      setPending({ id: order.id, action: "cancel" });
      try {
        const updated = await cancelOrder(order.id);
        onUpdated(updated);
        toast.success(
          fill(t.orders.actions.cancelledTemplate, {
            reference: updated.reference,
          }),
        );
      } catch (err) {
        if (isConflict(err)) {
          const fresh = await refresh(order.id);
          if (fresh) announceAlreadyDecided(fresh);
          else toast.info(t.orders.actions.outOfSync);
          return;
        }
        toast.error(apiErrorMessage(err, t, t.orders.actions.couldNotCancel));
      } finally {
        setPending(null);
      }
    },
    [announceAlreadyDecided, onUpdated, refresh, t],
  );

  const retry = useCallback(
    async (order: OrderView) => {
      setPending({ id: order.id, action: "retry" });
      try {
        const updated = await retryStorePush(order.id);
        onUpdated(updated);
        toast.success(
          fill(t.orders.actions.retryQueuedTemplate, {
            reference: updated.reference,
          }),
        );
      } catch (err) {
        if (isConflict(err)) {
          // Already re-queued by a colleague, or the push succeeded in the
          // meantime. Either way the current state is the interesting thing.
          await refresh(order.id);
          toast.info(t.orders.actions.outOfSync);
          return;
        }
        toast.error(apiErrorMessage(err, t, t.orders.actions.couldNotRetry));
      } finally {
        setPending(null);
      }
    },
    [onUpdated, refresh, t],
  );

  return { approve, reject, cancel, retry, pending };
}
