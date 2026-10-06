"use client";

import { useState } from "react";
import type { OrderPage, OrderSettings } from "@/lib/api/orders";
import { useTranslations } from "@/lib/i18n/provider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApprovalQueue } from "./approval-queue";
import { OrderSettingsPanel } from "./order-settings-panel";
import { OrdersList } from "./orders-list";

/**
 * The /orders lane. Three surfaces, one page, in the order a merchant needs
 * them: the decisions waiting on them, then the full history, then the
 * configuration that produced both.
 *
 * The settings panel is above the tabs rather than inside one because it is
 * the thing that explains an empty queue — "ordering is off" is only useful
 * next to the switch that turns it on.
 */
export function OrdersManager({
  queue,
  all,
  settings,
  canManage,
  settingsError,
  now,
  customerId,
  conversationId,
}: {
  queue: OrderPage;
  all: OrderPage;
  settings: OrderSettings | null;
  canManage: boolean;
  settingsError: string | null;
  now: number;
  customerId?: string;
  conversationId?: string;
}) {
  const t = useTranslations();
  const [current, setCurrent] = useState<OrderSettings | null>(settings);
  const [queueCount, setQueueCount] = useState(queue.orders.length);
  const [queueHasMore, setQueueHasMore] = useState(queue.nextCursor !== null);
  // A URL-scoped list ("orders from this customer") is never the queue.
  const [tab, setTab] = useState(
    customerId || conversationId ? "all" : "queue",
  );

  return (
    <div className="space-y-8">
      <OrderSettingsPanel
        initial={settings}
        canManage={canManage}
        initialError={settingsError}
        onChanged={setCurrent}
      />

      <Tabs value={tab} onValueChange={(value) => setTab(value as string)}>
        <TabsList>
          <TabsTrigger value="queue">
            {t.orders.tabs.queue}
            {queueCount > 0 ? (
              <span className="ms-1.5 rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-700 tabular-nums dark:text-amber-400">
                {queueCount}
                {queueHasMore ? "+" : ""}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="all">{t.orders.tabs.all}</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="pt-6">
          <ApprovalQueue
            initial={queue}
            mode={current?.mode ?? null}
            approvalWindowHours={current?.approvalWindowHours ?? null}
            now={now}
            onCountChange={(count, hasMore) => {
              setQueueCount(count);
              setQueueHasMore(hasMore);
            }}
          />
        </TabsContent>

        <TabsContent value="all" className="pt-6">
          <OrdersList
            initial={all}
            customerId={customerId}
            conversationId={conversationId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
