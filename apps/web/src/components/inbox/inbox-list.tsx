"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Search } from "lucide-react";
import {
  type ConversationSummary,
  type ConversationFilter,
  type MessageRole,
  listConversations,
} from "@/lib/api/inbox";
import { compactAge } from "@/lib/i18n/relative-time";
import { contactNameDir } from "@/lib/i18n/bidi";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { LabelChip } from "@/components/inbox/label-chip";
import { cn } from "@/lib/utils";

type InboxListProps = {
  initial: { items: ConversationSummary[]; nextCursor: string | null };
};

export function InboxList({ initial }: InboxListProps) {
  const t = useTranslations();
  const SCOPES: { label: string; value: boolean | undefined }[] = [
    { label: t.inbox.scopeAll, value: undefined },
    { label: t.inbox.scopeEscalated, value: true },
    { label: t.inbox.scopeHandled, value: false },
  ];
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [phone, setPhone] = useState("");
  const [escalated, setEscalated] = useState<boolean | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  const load = useCallback(
    async (filter: ConversationFilter, append: boolean) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const page = await listConversations({ ...filter, limit: 25 });
        if (id !== reqId.current) return; // a newer request superseded this one
        setItems((prev) => (append ? [...prev, ...page.items] : page.items));
        setCursor(page.nextCursor);
      } catch {
        if (id === reqId.current) setItems([]);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [],
  );

  // Debounce phone + refetch on filter change. Skips the very first render so
  // the server-provided initial page isn't immediately re-fetched.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const timer = setTimeout(() => {
      load({ phone: phone.trim() || undefined, escalated }, false);
    }, 300);
    return () => clearTimeout(timer);
  }, [phone, escalated, load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-xs">
          <Search className="absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t.inbox.searchPlaceholder}
            className="ps-9"
            inputMode="tel"
            aria-label={t.inbox.searchAriaLabel}
          />
        </div>
        <div
          role="tablist"
          aria-label={t.inbox.filterAriaLabel}
          className="inline-flex rounded-lg border border-border p-0.5"
        >
          {SCOPES.map((s) => (
            <button
              key={s.label}
              role="tab"
              aria-selected={escalated === s.value}
              onClick={() => setEscalated(s.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                escalated === s.value
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t.inbox.noConversations}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {items.map((c) => (
            <li key={c.id}>
              <Row conversation={c} />
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() =>
              load(
                { phone: phone.trim() || undefined, escalated, cursor },
                true,
              )
            }
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : null}
            {t.inbox.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Row({ conversation: c }: { conversation: ConversationSummary }) {
  const t = useTranslations();
  const locale = useLocale();
  const sender = previewSender(c.lastMessage?.role, t);

  return (
    <Link
      href={`/inbox/${c.id}`}
      className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-secondary/50 focus-visible:bg-secondary/50 focus-visible:outline-none"
    >
      <div className="min-w-0 flex-1">
        {/* Wraps on a phone so the badges move to a second line instead of
            squeezing the contact's name down to one character. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            dir={contactNameDir(c.customerName)}
            className="min-w-0 truncate text-sm font-medium"
          >
            {c.customerName ?? c.customerPhone}
          </span>
          <ChannelBadge channel={c.channel} />
          <LabelChip label={c.label} />
          {c.escalated ? (
            <span className="eyebrow rounded bg-secondary px-1.5 py-0.5 text-muted-foreground">
              {t.inbox.escalatedBadge}
            </span>
          ) : null}
        </div>
        {c.lastMessage ? (
          <p className="flex min-w-0 gap-1 text-sm text-muted-foreground">
            {sender ? (
              <span className="shrink-0 font-medium">
                {sender}
                <span aria-hidden="true"> ·</span>
              </span>
            ) : null}
            {/* Customer and agent text can be either script: let it set its
                own direction so punctuation and ellipsis land on its end. */}
            <span dir="auto" className="min-w-0 truncate text-start">
              {c.lastMessage.content}
            </span>
          </p>
        ) : (
          <p className="truncate text-sm text-muted-foreground">
            {t.inbox.noMessagesRetained}
          </p>
        )}
      </div>
      <time
        dateTime={c.lastInboundAt}
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
      >
        {compactAge(c.lastInboundAt, locale)}
      </time>
    </Link>
  );
}

/** Who sent the previewed message; the customer's own words carry no prefix. */
function previewSender(
  role: MessageRole | undefined,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (role === "assistant") return t.inbox.previewSenderAgent;
  if (role === "human_agent") return t.inbox.previewSenderTeam;
  return null;
}
