"use client";

import type { ChannelKind } from "@/lib/api/inbox";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

// Brand-adjacent dot colours, kept subtle so the badge reads as metadata.
const DOT_CLASS: Record<ChannelKind, string> = {
  whatsapp: "bg-emerald-500",
  messenger: "bg-sky-500",
  instagram: "bg-fuchsia-500",
  web: "bg-lime-500",
};

export function channelLabel(channel: ChannelKind, t: Dictionary): string {
  switch (channel) {
    case "messenger":
      return t.channels.kindMessenger;
    case "instagram":
      return t.channels.kindInstagram;
    case "web":
      return t.channels.kindWeb;
    default:
      return t.channels.kindWhatsapp;
  }
}

/**
 * Which channel a conversation came in on. `channel` is data, not a code
 * path (Feature 16): one inbox, one badge.
 */
export function ChannelBadge({
  channel,
  className,
}: {
  channel: ChannelKind;
  className?: string;
}) {
  const t = useTranslations();
  const label = channelLabel(channel, t);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground",
        className,
      )}
      title={t.channels.channelBadgeAriaTemplate.replace("{channel}", label)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", DOT_CLASS[channel] ?? DOT_CLASS.whatsapp)}
      />
      <span className="sr-only">
        {t.channels.channelBadgeAriaTemplate.replace("{channel}", label)}
      </span>
      <span aria-hidden="true">{label}</span>
    </span>
  );
}
