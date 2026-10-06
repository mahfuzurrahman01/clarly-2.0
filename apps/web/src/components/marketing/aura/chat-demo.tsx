"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { FileText, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { Bubble, ChatComposer, ChatHeader, Phone, StatusBar, Typing } from "@/components/marketing/landing/phone";
import landing from "@/components/marketing/landing/landing.module.css";
import { useReducedMotion } from "./use-reduced-motion";
import s from "./aura.module.css";

type Step =
  | { kind: "msg"; side: "in" | "out" | "note"; node: ReactNode; hold: number }
  | { kind: "typing"; hold: number };

/** Pause before the finished conversation fades out and starts again. */
const END_HOLD_MS = 4200;
const RESET_FADE_MS = 500;

/**
 * A WhatsApp conversation that plays on a loop inside the phone: a customer
 * asks, Clarly answers with its sources, then a question it shouldn't answer
 * goes to a person who picks up the same chat. Built from the landing page's
 * answer + handoff copy so both stay in sync. Pauses off-screen and in
 * background tabs; shows the whole conversation, still, under reduced motion.
 */
export function ChatDemo({
  answer,
  handoff,
  label,
  height = "34rem",
  className,
}: {
  answer: LandingContent["answer"]["chat"];
  handoff: LandingContent["handoff"]["chat"];
  label: string;
  height?: string;
  className?: string;
}) {
  const script = useMemo<Step[]>(
    () => [
      { kind: "msg", side: "in", hold: 900, node: <Bubble kind="in" time={answer.time}>{answer.question}</Bubble> },
      { kind: "typing", hold: 1400 },
      { kind: "msg", side: "out", hold: 500, node: <Bubble kind="out" time={answer.time}>{answer.reply}</Bubble> },
      {
        kind: "msg",
        side: "note",
        hold: 2400,
        node: (
          <span className={s.note}>
            <FileText className="size-3" aria-hidden />
            <span className="eyebrow">{answer.cite}</span>
          </span>
        ),
      },
      { kind: "msg", side: "in", hold: 900, node: <Bubble kind="in" time={handoff.time}>{handoff.question}</Bubble> },
      { kind: "typing", hold: 1400 },
      { kind: "msg", side: "out", hold: 500, node: <Bubble kind="out" time={handoff.time}>{handoff.reply}</Bubble> },
      {
        kind: "msg",
        side: "note",
        hold: 1300,
        node: (
          <span className={s.noteChip} data-tone="signal">
            <UserRound aria-hidden />
            {handoff.tag}
          </span>
        ),
      },
      {
        kind: "msg",
        side: "out",
        hold: END_HOLD_MS,
        node: (
          <Bubble kind="human" who={handoff.nurseName} time={handoff.nurseTime}>
            {handoff.nurse}
          </Bubble>
        ),
      },
    ],
    [answer, handoff],
  );

  const root = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const [active, setActive] = useState(false);
  const [resetting, setResetting] = useState(false);
  const still = useReducedMotion();

  // Play only while visible and in a foreground tab.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let onScreen = false;
    const sync = () => setActive(onScreen && document.visibilityState === "visible");
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      sync();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  // One timer per beat: show the next step after the current one's hold; after
  // the last, fade out, then start over.
  useEffect(() => {
    if (!active || still) return;
    const done = shown >= script.length;
    const wait = resetting ? RESET_FADE_MS : shown === 0 ? 700 : script[shown - 1].hold;
    const t = window.setTimeout(() => {
      if (resetting) {
        setShown(0);
        setResetting(false);
      } else if (done) setResetting(true);
      else setShown((n) => n + 1);
    }, wait);
    return () => window.clearTimeout(t);
  }, [active, still, shown, resetting, script]);

  const visible = still ? script : script.slice(0, shown);
  const typing = !still && visible.at(-1)?.kind === "typing";

  return (
    <div ref={root} className={cn(landing.tokens, s.demo, className)} style={{ "--phone-h": height } as CSSProperties}>
      <Phone label={label} className={s.demoPhone}>
        <StatusBar time={answer.time} />
        <ChatHeader clinic={answer.clinic} status={answer.status} initial={answer.initial} />
        <div className={s.thread} data-resetting={resetting ? "" : undefined} aria-live="off">
          {visible.map((step, i) =>
            step.kind === "msg" ? (
              <div key={i} className={s.msg} data-side={step.side === "in" ? "in" : "out"}>
                {step.node}
              </div>
            ) : null,
          )}
          {typing ? (
            <div className={cn(s.msg, s.typingOn)} data-side="out">
              <Typing />
            </div>
          ) : null}
        </div>
        <ChatComposer placeholder={answer.placeholder} />
      </Phone>
    </div>
  );
}
