"use client";

import { AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import type { StockStatus } from "@/lib/api/catalog";
import { useTranslations } from "@/lib/i18n/provider";

/**
 * Stock state is carried by colour AND an icon AND a word — the list is read
 * by people restocking shelves, and "is this red or green" is not a signal
 * everyone gets.
 */
export function StockStatusBadge({ status }: { status: StockStatus }) {
  const t = useTranslations();

  if (status === "in_stock") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        <CheckCircle2 className="size-3" />
        {t.catalog.stockInStock}
      </span>
    );
  }
  if (status === "out_of_stock") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs text-destructive">
        <XCircle className="size-3" />
        {t.catalog.stockOutOfStock}
      </span>
    );
  }
  if (status === "low_stock") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="size-3" />
        {t.catalog.stockLow}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
      <Clock className="size-3" />
      {t.catalog.stockPreOrder}
    </span>
  );
}
