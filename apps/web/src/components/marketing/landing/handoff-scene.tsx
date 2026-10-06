"use client";

import { useRef } from "react";
import { CircleAlert, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import { Bubble, ChatComposer, ChatHeader, Phone, RichText, StatusBar } from "./phone";
import { gsap, landingMedia, offsetWithin, onceInView, pad2, scoped, ScrollTrigger, SCRUB, useGSAP } from "./motion";
import s from "./landing.module.css";

/** The clinic's hand-off threshold, and the confidence before/after the question. */
const THRESHOLD = 0.7;
const CONFIDENT = 0.94;
const UNSURE = 0.41;
/** Seconds the ticket waits before the nurse claims it, against the 15-minute stuck alert. */
const WAIT_SECONDS = 48;
const STUCK_AFTER_SECONDS = 15 * 60;

/* Gauge geometry: a 180° arc centred at (100,100), radius 80. */
const arcPoint = (v: number, r: number) => {
  const a = Math.PI - v * Math.PI;
  return [100 + r * Math.cos(a), 100 - r * Math.sin(a)] as const;
};
const [TX1, TY1] = arcPoint(THRESHOLD, 68);
const [TX2, TY2] = arcPoint(THRESHOLD, 94);
const needleRotation = (v: number) => (v - 0.5) * 180;

/**
 * 03 · Handoff — a question it must not answer: confidence drops under the
 * line, the guardrail lights, and the ticket lifts out of the chat and moves
 * New → Claimed → Resolved while the nurse joins the same conversation.
 */
export function HandoffScene({ c }: { c: LandingContent["handoff"] }) {
  const root = useRef<HTMLElement>(null);
  const { ticket, columns } = c.board;

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const mm = landingMedia(el, {
        full: () => {
          const grid = one("[data-part=grid]");
          const phone = one("[data-part=phone]");
          const card = one("[data-part=ticket]");
          const slots = { new: one("[data-part=slot-new]"), claimed: one("[data-part=slot-claimed]"), resolved: one("[data-part=slot-resolved]") };
          const status = {
            new: one("[data-status=new]"),
            claimed: one("[data-status=claimed]"),
            resolved: one("[data-status=resolved]"),
          };
          const gauge = one<SVGSVGElement>("[data-part=gauge]");
          const needle = one<SVGLineElement>("[data-part=needle]");
          const arc = one<SVGPathElement>("[data-part=val]");
          const readout = one("[data-part=readout]");
          const waitEl = one("[data-part=wait]");

          // The flying ticket is absolutely positioned over the grid; the slots
          // reserve its size in each column so it has somewhere to land.
          const sizeTicket = () => {
            gsap.set(card, { width: slots.resolved.offsetWidth });
            const h = card.offsetHeight;
            Object.values(slots).forEach((slot) => (slot.style.height = `${h}px`));
          };
          sizeTicket();
          ScrollTrigger.addEventListener("refreshInit", sizeTicket);
          const slotX = (slot: HTMLElement) => () => offsetWithin(slot, grid).x;
          const slotY = (slot: HTMLElement) => () => offsetWithin(slot, grid).y;
          const fromPhone = () => {
            const o = offsetWithin(phone, grid);
            return { x: o.x + (o.w - card.offsetWidth) / 2, y: o.y + o.h * 0.5 };
          };

          const g = { v: CONFIDENT };
          const renderGauge = () => {
            gsap.set(needle, { rotation: needleRotation(g.v), svgOrigin: "100 100" });
            arc.setAttribute("stroke-dashoffset", String(100 - g.v * 100));
            readout.textContent = g.v.toFixed(2);
            gauge.classList.toggle(s.gaugeAbove, g.v >= THRESHOLD);
          };
          const wait = { s: 0 };
          const renderWait = () => {
            const sec = Math.round(wait.s);
            waitEl.textContent = `${Math.floor(sec / 60)}:${pad2(sec % 60)}`;
          };
          // GSAP owns the needle's transform while animating; the static
          // attribute comes back when this mode is reverted.
          const staticNeedle = needle.getAttribute("transform");
          needle.removeAttribute("transform");
          renderGauge();
          renderWait();

          gsap.set(["[data-part=question]", "[data-part=refusal]", "[data-part=tag]", "[data-part=nurse]", "[data-part=guard-hit]"], { autoAlpha: 0 });
          gsap.set(card, { x: () => fromPhone().x, y: () => fromPhone().y, autoAlpha: 0, scale: 0.6 });
          gsap.set([status.claimed, status.resolved], { autoAlpha: 0 });
          gsap.set(status.new, { autoAlpha: 1 });

          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.fromTo("[data-part=question]", { autoAlpha: 0, y: 14, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.6)" }, 0.3)
            .to(g, { v: UNSURE, duration: 1.4, ease: "power2.inOut", onUpdate: renderGauge }, 1)
            .fromTo("[data-part=guard-hit]", { autoAlpha: 0, scale: 0.8 }, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, 1.9)
            .fromTo("[data-part=refusal]", { autoAlpha: 0, scale: 0.96 }, { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, 2.6)
            .fromTo("[data-part=tag]", { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.3 }, 3)
            // The ticket lifts out of the chat and lands in "New".
            .to(card, { autoAlpha: 1, scale: 1, duration: 0.35, ease: "back.out(1.8)" }, 3.3)
            .to(card, { x: slotX(slots.new), y: slotY(slots.new), duration: 1, ease: "power3.inOut" }, 3.7)
            .to(card, { keyframes: { rotation: [0, -6, 3, 0] }, duration: 1, ease: "sine.inOut" }, 3.7)
            .to(wait, { s: WAIT_SECONDS, duration: 1, onUpdate: renderWait }, 4.7)
            .to("[data-part=stuck-bar]", { scaleX: WAIT_SECONDS / STUCK_AFTER_SECONDS, duration: 1 }, 4.7)
            // Claimed by the nurse, who joins the same chat.
            .to(status.new, { autoAlpha: 0, duration: 0.2 }, 5.8)
            .to(status.claimed, { autoAlpha: 1, duration: 0.2 }, 5.85)
            .to(card, { x: slotX(slots.claimed), y: slotY(slots.claimed), duration: 0.9, ease: "power3.inOut" }, 5.9)
            .fromTo("[data-part=nurse]", { autoAlpha: 0, y: 14, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" }, 6.3)
            // Resolved.
            .to(status.claimed, { autoAlpha: 0, duration: 0.2 }, 7.3)
            .to(status.resolved, { autoAlpha: 1, duration: 0.2 }, 7.35)
            .to(["[data-part=stuck]", "[data-part=wait-row]"], { autoAlpha: 0, duration: 0.2 }, 7.3)
            .to(card, { x: slotX(slots.resolved), y: slotY(slots.resolved), duration: 0.9, ease: "power3.inOut" }, 7.4)
            .to({}, { duration: 1 });

          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: "+=3600",
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
          });
          return () => {
            ScrollTrigger.removeEventListener("refreshInit", sizeTicket);
            gsap.set(needle, { clearProps: "transform" });
            if (staticNeedle) needle.setAttribute("transform", staticNeedle);
          };
        },
        lite: () => {
          all("[data-part=reveal]").forEach((node) =>
            onceInView(node, () => gsap.from(node, { y: 28, autoAlpha: 0, duration: 0.8, ease: "power3.out" }), "top 90%"),
          );
        },
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  const others = [c.board.claimed, c.board.resolved];
  return (
    <section ref={root} id="handoff" data-chapter={c.chapter} className={s.scene}>
      <div className={cn(s.wrap, s.pinwrap, s.hGrid)} data-part="grid">
        <div data-part="reveal">
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>
            <RichText parts={c.title} />
          </h2>
          <p className={s.lede}>{c.body}</p>
          <p className={cn("eyebrow", s.guardLabel)}>{c.guardsLabel}</p>
          <div className={s.guards}>
            {c.guards.map((guard, i) => (
              <span key={guard} className={cn(s.chip, s.guardChip)}>
                <Lock className={s.icon} aria-hidden />
                {guard}
                {i === c.hitGuard ? (
                  <span className={s.guardHit} data-part="guard-hit">
                    <CircleAlert className={s.icon} aria-hidden />
                    {guard}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        </div>

        <Phone label={c.phoneLabel} data-part="phone">
          <StatusBar time={c.chat.time} />
          <ChatHeader clinic={c.chat.clinic} status={c.chat.status} initial={c.chat.initial} />
          <div className={s.chatBody}>
            <Bubble kind="out" dim time={c.chat.previous.time}>
              {c.chat.previous.text}
            </Bubble>
            <Bubble kind="in" time={c.chat.time} data-part="question">
              {c.chat.question}
            </Bubble>
            <Bubble kind="out" time={c.chat.time} data-part="refusal">
              {c.chat.reply}
            </Bubble>
            <div className={cn(s.meta, s.metaEnd, s.metaSignal)} data-part="tag">
              <span className={s.live} />
              <span className="eyebrow">{c.chat.tag}</span>
            </div>
            <Bubble kind="human" who={c.chat.nurseName} time={c.chat.nurseTime} data-part="nurse">
              {c.chat.nurse}
            </Bubble>
          </div>
          <ChatComposer placeholder={c.chat.placeholder} />
        </Phone>

        <div className={s.hRight} data-part="reveal">
          <div className={s.gaugeCard}>
            <svg className={s.gauge} data-part="gauge" viewBox="0 0 200 118" aria-hidden>
              <path data-part="track" d="M 20 100 A 80 80 0 0 1 180 100" fill="none" strokeWidth={12} strokeLinecap="round" />
              <path
                data-part="val"
                d="M 20 100 A 80 80 0 0 1 180 100"
                fill="none"
                strokeWidth={12}
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={100}
                strokeDashoffset={100 - UNSURE * 100}
              />
              <line data-part="tick" x1={TX1} y1={TY1} x2={TX2} y2={TY2} />
              <line
                data-part="needle"
                x1={100}
                y1={100}
                x2={100}
                y2={36}
                transform={`rotate(${needleRotation(UNSURE)} 100 100)`}
              />
              <circle data-part="hub" cx={100} cy={100} r={6} />
            </svg>
            <div>
              <div className="eyebrow text-muted-foreground">{c.gauge.label}</div>
              <div className={s.gaugeNum} data-part="readout">
                {UNSURE.toFixed(2)}
              </div>
              <p className={s.gaugeRule}>
                {c.gauge.ruleBefore} <b>{THRESHOLD.toFixed(2)}</b>
                {c.gauge.ruleAfter}
              </p>
            </div>
          </div>

          <div className={s.board}>
            <div className={s.col}>
              <div className={cn("eyebrow", s.colHead)}>
                <span>{columns[0]}</span>
                <span>0</span>
              </div>
              <div className={s.slot} data-part="slot-new" />
            </div>
            <div className={s.col}>
              <div className={cn("eyebrow", s.colHead)}>
                <span>{columns[1]}</span>
                <span>1</span>
              </div>
              <div className={s.slot} data-part="slot-claimed" />
              <OtherTicket t={others[0]} />
            </div>
            <div className={s.col}>
              <div className={cn("eyebrow", s.colHead)}>
                <span>{columns[2]}</span>
                <span>2</span>
              </div>
              <div className={s.slot} data-part="slot-resolved" />
              <article className={cn(s.ticket, s.ticketHero)} data-part="ticket">
                <div className={s.tRow}>
                  <span>{ticket.id}</span>
                  <span className={s.waitRow} data-part="wait-row">
                    {ticket.waiting} <span data-part="wait">0:{pad2(WAIT_SECONDS)}</span>
                  </span>
                </div>
                <div className={s.tTitle}>{ticket.title}</div>
                <div className={s.tReason}>{ticket.reason}</div>
                <div className={s.stuck} data-part="stuck">
                  <i data-part="stuck-bar" />
                </div>
                <div className={s.tFoot}>
                  <div className={s.tStatus}>
                    <span data-status="new">
                      <CircleAlert className={s.icon} aria-hidden />
                      {ticket.statusNew}
                    </span>
                    <span data-status="claimed">
                      <span className={cn(s.avatar, s.avatarSm, s.avatarLime)}>{ticket.claimerInitial}</span>
                      {ticket.statusClaimed}
                    </span>
                    <span data-status="resolved">
                      <span className={s.live} />
                      {ticket.statusResolved}
                    </span>
                  </div>
                </div>
              </article>
              <OtherTicket t={others[1]} />
            </div>
          </div>
          <p className={cn("eyebrow", s.boardNote)}>
            <CircleAlert className={s.icon} aria-hidden />
            {c.note}
          </p>
        </div>
      </div>
    </section>
  );
}

function OtherTicket({ t }: { t: LandingContent["handoff"]["board"]["claimed"] }) {
  return (
    <article className={s.ticket}>
      <div className={s.tRow}>
        <span>{t.id}</span>
        <span>{t.time}</span>
      </div>
      <div className={s.tTitle}>{t.title}</div>
      <div className={s.tReason}>{t.reason}</div>
      <div className={s.tFoot}>
        <span className={cn(s.avatar, s.avatarSm)}>{t.initial}</span>
        <span>{t.who}</span>
      </div>
    </article>
  );
}
