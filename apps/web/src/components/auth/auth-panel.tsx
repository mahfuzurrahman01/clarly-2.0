import type { CSSProperties } from "react";
import Link from "next/link";
import { ShieldCheck, UserRound, Zap } from "lucide-react";
import { AuraSky } from "@/components/marketing/aura/aura-sky";
import { ChatDemo } from "@/components/marketing/aura/chat-demo";
import s from "@/components/marketing/aura/aura.module.css";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { cn } from "@/lib/utils";

/**
 * Brand side of the auth pages: the landing sky, a phone playing a real
 * Clarly conversation (answer with sources → hand-off to a person), chips
 * calling out what just happened, and the product promise.
 */
export function AuthPanel({ t, c }: { t: Dictionary; c: Pick<LandingContent, "answer" | "handoff"> }) {
  const chips = [
    { icon: Zap, text: c.answer.timeline[1].text },
    { icon: ShieldCheck, text: c.answer.chat.meta },
    { icon: UserRound, text: c.handoff.chat.tag },
  ];

  return (
    <aside className={cn(s.authPanel, "hidden flex-col justify-between gap-8 p-10 lg:flex xl:p-12")}>
      <AuraSky glows={["center", "end"]} />
      <Link
        href="/"
        className="relative inline-flex w-fit items-baseline gap-1.5 font-display text-xl font-medium tracking-tight"
      >
        {t.common.brand}
        <span aria-hidden className="size-1.5 rounded-full bg-lime-ring" />
      </Link>

      <div className={s.authStage}>
        {chips.map(({ icon: Icon, text }, i) => (
          <span key={text} className={cn(s.glass, s.floatChip)} style={{ "--i": i } as CSSProperties} aria-hidden>
            <Icon />
            {text}
          </span>
        ))}
        <ChatDemo
          answer={c.answer.chat}
          handoff={c.handoff.chat}
          label={c.answer.phoneLabel}
          height="min(32rem, calc(100svh - 17rem))"
        />
      </div>

      <div className="relative space-y-4">
        <blockquote className="max-w-md font-display text-2xl font-medium leading-snug tracking-tight xl:text-3xl">
          {t.auth.quoteLine1}
          <br />
          {t.auth.quoteLine2Prefix}
          <em className={s.em}>{t.auth.quoteLine2What}</em>
        </blockquote>
        <p className="eyebrow text-muted-foreground">{t.common.tagline}</p>
      </div>
    </aside>
  );
}
