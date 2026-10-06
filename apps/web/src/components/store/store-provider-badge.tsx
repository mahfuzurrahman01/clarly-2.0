"use client";

import type { StoreProviderName } from "@/lib/api/store";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

// Brand-adjacent dot colours, same convention as ChannelBadge — kept subtle
// so the badge reads as metadata, not a logo wall.
const DOT_CLASS: Record<StoreProviderName, string> = {
  salla: "bg-lime-500",
  zid: "bg-orange-500",
  shopify: "bg-emerald-600",
  woocommerce: "bg-purple-500",
};

export function storeProviderLabel(provider: StoreProviderName, t: Dictionary): string {
  switch (provider) {
    case "salla":
      return t.store.providerSalla;
    case "zid":
      return t.store.providerZid;
    case "shopify":
      return t.store.providerShopify;
    case "woocommerce":
      return t.store.providerWoocommerce;
  }
}

export function StoreProviderBadge({
  provider,
  className,
}: {
  provider: StoreProviderName;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", DOT_CLASS[provider])}
      />
      {storeProviderLabel(provider, t)}
    </span>
  );
}
