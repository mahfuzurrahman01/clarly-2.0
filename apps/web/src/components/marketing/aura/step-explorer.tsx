"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { BookOpen, FileText, MessagesSquare, UserRoundCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { Bubble } from "@/components/marketing/landing/phone";
import landing from "@/components/marketing/landing/landing.module.css";
import { Spotlight } from "./spotlight";
import { useReducedMotion } from "./use-reduced-motion";
import s from "./aura.module.css";

/** How long each step stays selected before the explorer advances on its own. */
const STEP_MS = 6500;
/** Knowledge-base cells shown in the dot grid (12 columns). */
const KB_CELLS = 60;

type StepCopy = { title: string; body: string };

const ICONS = [BookOpen, MessagesSquare, UserRoundCheck];

/**
 * "How it works" as three tabs: knowledge → answers → handoff. Each tab shows
 * a small live picture of that step. It advances on its own (a progress bar
 * shows when), pauses while hovered or focused, and follows the WAI-ARIA tabs
 * pattern for keyboard users (arrows, Home/End). Static under reduced motion.
 */
export function StepExplorer({
  steps,
  c,
}: {
  steps: [StepCopy, StepCopy, StepCopy];
  c: Pick<LandingContent, "knowledge" | "answer" | "handoff">;
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [touched, setTouched] = useState(false);
  const reduced = useReducedMotion();
  // Tours on its own until the visitor picks a step (or prefers no motion).
  const auto = !touched && !reduced;
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  useEffect(() => {
    if (!auto || paused) return;
    const t = window.setTimeout(() => setActive((a) => (a + 1) % steps.length), STEP_MS);
    return () => window.clearTimeout(t);
  }, [active, auto, paused, steps.length]);

  function select(i: number, focus = false) {
    setActive(i);
    setTouched(true); // a deliberate choice stops the tour
    if (focus) tabs.current[i]?.focus();
  }

  function onKey(e: KeyboardEvent) {
    const last = steps.length - 1;
    const forward = getComputedStyle(e.currentTarget).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
    const next =
      e.key === "ArrowDown" || e.key === forward
        ? (active + 1) % steps.length
        : e.key === "ArrowUp" || e.key === back
          ? (active + last) % steps.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    select(next, true);
  }

  return (
    <div
      className="grid items-center gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-14"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div
        role="tablist"
        aria-orientation="vertical"
        className={s.steps}
        data-paused={paused || !auto ? "" : undefined}
        style={{ "--step-ms": `${STEP_MS}ms` } as CSSProperties}
        onKeyDown={onKey}
      >
        {steps.map((step, i) => {
          const Icon = ICONS[i];
          const selected = i === active;
          return (
            <button
              key={step.title}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              id={`${id}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel`}
              tabIndex={selected ? 0 : -1}
              className={s.stepBtn}
              onClick={() => select(i)}
            >
              <span className={s.stepNum}>
                <Icon className="size-5" aria-hidden />
              </span>
              <span>
                <span className={s.stepTitle}>{step.title}</span>
                <span className={s.stepBody}>
                  <p>{step.body}</p>
                </span>
              </span>
              {auto ? <span className={s.stepBar} key={`${active}-${i}`} aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <Spotlight
        id={`${id}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${active}`}
        className={cn(landing.tokens, s.stage)}
      >
        <div key={active} className={s.stagePanel}>
          {active === 0 ? <KnowledgeVisual c={c.knowledge} /> : null}
          {active === 1 ? <AnswerVisual c={c.answer} /> : null}
          {active === 2 ? <HandoffVisual c={c.handoff} /> : null}
        </div>
      </Spotlight>
    </div>
  );
}

function KnowledgeVisual({ c }: { c: LandingContent["knowledge"] }) {
  const total = c.docs.reduce((n, d) => n + d.passages, 0);
  const on = Math.min(KB_CELLS, total);
  return (
    <div className="space-y-2">
      {c.docs.map((doc, i) => (
        <div key={doc.name} className={s.docRow} style={{ "--i": i } as CSSProperties}>
          <FileText aria-hidden />
          <span dir="auto" className="truncate">
            {doc.name}
          </span>
          <span className={s.docCount}>
            {doc.passages} {c.passagesWord}
          </span>
        </div>
      ))}
      <div className="flex items-baseline justify-between pt-4 text-sm">
        <b className="font-medium">{c.kbTitle}</b>
        <span className="eyebrow text-muted-foreground">{c.kbOwner}</span>
      </div>
      <div className={s.dotGrid} aria-hidden>
        {Array.from({ length: KB_CELLS }, (_, i) => (
          <span key={i} data-on={i < on ? "" : undefined} style={{ "--i": i } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}

function AnswerVisual({ c }: { c: LandingContent["answer"] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-start">
        <Bubble kind="in" time={c.chat.time}>
          {c.chat.question}
        </Bubble>
      </div>
      <div className="flex flex-col items-end">
        <Bubble kind="out" time={c.chat.time}>
          {c.chat.reply}
        </Bubble>
      </div>
      {c.sources.map((src, i) => (
        <article
          key={src.file}
          className={s.srcCard}
          data-unused={src.unused ? "" : undefined}
          style={{ "--i": i } as CSSProperties}
        >
          <div className={cn("eyebrow", s.srcFile)}>
            <FileText className="size-3" aria-hidden />
            <span dir="auto">{src.file}</span>
          </div>
          {src.before}
          {src.mark ? <mark>{src.mark}</mark> : null}
          {src.after}
        </article>
      ))}
    </div>
  );
}

function HandoffVisual({ c }: { c: LandingContent["handoff"] }) {
  const t = c.board.ticket;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="eyebrow mb-2 text-muted-foreground">{c.guardsLabel}</p>
        <div className={s.guards}>
          {c.guards.map((g, i) => (
            <span key={g} className={s.guard} data-hit={i === c.hitGuard ? "" : undefined}>
              {g}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-col items-start">
        <Bubble kind="in" time={c.chat.time}>
          {c.chat.question}
        </Bubble>
      </div>
      <div className={s.ticket}>
        <div className={s.ticketTop}>
          <span className="font-mono">{t.id}</span>
          <span className={s.status}>{t.statusNew}</span>
        </div>
        <p className="mt-2 font-medium">{t.title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t.reason}</p>
      </div>
      <div className="flex flex-col items-end">
        <Bubble kind="human" who={c.chat.nurseName} time={c.chat.nurseTime}>
          {c.chat.nurse}
        </Bubble>
      </div>
    </div>
  );
}
