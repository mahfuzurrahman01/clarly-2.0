import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Inline } from "@/lib/i18n/landing/types";
import s from "./landing.module.css";

/* Presentational building blocks shared by the scenes. No motion here — the
   scenes target these through data-part attributes. */

export function Phone({
  label,
  night,
  className,
  children,
  ...rest
}: { label: string; night?: boolean } & ComponentPropsWithoutRef<"div">) {
  return (
    <div role="figure" aria-label={label} className={cn(s.phone, night && s.phoneNight, className)} {...rest}>
      <div className={s.screen}>{children}</div>
    </div>
  );
}

export function StatusBar({ time }: { time?: string }) {
  return (
    <div className={s.status} aria-hidden>
      <span>{time}</span>
      <span>●●● 5G</span>
    </div>
  );
}

export function ChatHeader({ clinic, status, initial }: { clinic: string; status: string; initial: string }) {
  return (
    <div className={s.chatHead}>
      <span className={s.avatar}>{initial}</span>
      <div>
        <div className={s.chatName}>{clinic}</div>
        <div className={s.chatSub}>
          <span className={s.live} />
          {status}
        </div>
      </div>
    </div>
  );
}

export function ChatComposer({ placeholder }: { placeholder: string }) {
  return (
    <div className={s.composer} aria-hidden>
      <div className={s.composerField}>{placeholder}</div>
      <div className={s.composerSend}>
        <Send className={cn(s.icon, s.flip)} />
      </div>
    </div>
  );
}

type BubbleKind = "in" | "out" | "human";
const BUBBLE_CLASS: Record<BubbleKind, string> = { in: s.bubbleIn, out: s.bubbleOut, human: s.bubbleHuman };

export function Bubble({
  kind,
  time,
  who,
  dim,
  className,
  children,
  ...rest
}: {
  kind: BubbleKind;
  time?: string;
  who?: string;
  dim?: boolean;
} & ComponentPropsWithoutRef<"div">) {
  return (
    <div className={cn(s.bubble, BUBBLE_CLASS[kind], dim && s.bubbleDim, className)} {...rest}>
      {who ? <span className={s.bubbleWho}>{who}</span> : null}
      {children}
      {time ? <span className={s.bubbleTime}>{time}</span> : null}
    </div>
  );
}

export function Typing(props: ComponentPropsWithoutRef<"div">) {
  return (
    <div className={s.typing} aria-hidden {...props}>
      <span />
      <span />
      <span />
    </div>
  );
}

/** Renders heading runs, wrapping emphasised runs in <em>. */
export function RichText({ parts, emClassName = s.em }: { parts: Inline[]; emClassName?: string }): ReactNode {
  return parts.map((p, i) =>
    p.em ? (
      <em key={i} className={emClassName}>
        {p.text}
      </em>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}
