"use client";

import { useRef, type CSSProperties } from "react";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import type { LandingAction } from "./landing-action";
import { Phone, StatusBar } from "./phone";
import { StarField } from "./star-field";
import {
  gsap,
  landingMedia,
  onceInView,
  pad2,
  scoped,
  ScrollTrigger,
  SCRUB,
  setHeaderTone,
  useGSAP,
  inlineSign,
  type HeaderTone,
} from "./motion";
import s from "./landing.module.css";

/** Unread count on the lock screen by morning — the cost of an unanswered night. */
const UNREAD_BY_MORNING = 47;

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const formatClock = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

/** Pinned scroll length of the hero, in viewport heights. The messages finish around halfway. */
const PIN_VIEWPORTS = 3.2;

/**
 * 00 · Night — the hero. Pinned: the clock runs from the first unanswered
 * message to the last while notifications pile up and captions tell the
 * night; then the sun rises, the page turns to paper, and the paper settles
 * back into the page theme for the next scene.
 */
export function NightScene({ c, primary }: { c: LandingContent["night"]; primary: LandingAction }) {
  const root = useRef<HTMLElement>(null);
  const newest = c.notifications[0];
  const oldest = c.notifications[c.notifications.length - 1];

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);

      const toneWhileVisible = () => {
        setHeaderTone("night");
        ScrollTrigger.create({
          trigger: el,
          start: "top top+=32",
          end: "bottom top+=32",
          onToggle: (st) => setHeaderTone(st.isActive ? "night" : "page"),
        });
      };

      const mm = landingMedia(el, {
        full: () => {
          const slots = all("[data-part=notif]"); // newest first
          const caps = all("[data-part=cap]");
          const clockEl = one("[data-part=clock]");
          const unreadEl = one("[data-part=unread]");
          const minutes = c.notifications.map((n) => toMinutes(n.time));
          const start = minutes[minutes.length - 1];
          const end = minutes[0];
          const CLOCK_SPAN = 4; // timeline units the clock takes to run the night
          const at = (m: number) => 0.6 + ((m - start) / (end - start)) * CLOCK_SPAN;

          const clock = { m: start };
          const unread = { n: 1 };
          const render = () => {
            clockEl.textContent = formatClock(Math.round(clock.m));
            unreadEl.textContent = String(Math.round(unread.n));
          };
          render();
          gsap.set(caps, { y: 40 });
          gsap.set("[data-part=sun]", { yPercent: 40, scale: 0.6 });

          const tl = gsap.timeline({ defaults: { ease: "none" } });
          tl.to("[data-part=hero-copy]", { autoAlpha: 0, y: -60, duration: 0.9, ease: "power1.in" }, 0)
            .to("[data-part=cue]", { autoAlpha: 0, duration: 0.3 }, 0)
            .to(clock, { m: end, duration: CLOCK_SPAN, onUpdate: render }, 0.6)
            .to(unread, { n: UNREAD_BY_MORNING, duration: CLOCK_SPAN }, 0.6);

          // Arrivals: each new message opens its row (0fr → 1fr), pushing older ones down.
          for (let k = slots.length - 2; k >= 0; k--) {
            tl.fromTo(
              slots[k],
              { gridTemplateRows: "0fr", opacity: 0 },
              { gridTemplateRows: "1fr", opacity: 1, duration: 0.4, ease: "power3.out" },
              at(minutes[k]),
            );
          }

          // Captions: each holds until the next one's moment on the clock.
          c.captions.forEach((cap, i) => {
            const inAt = i === 0 ? 0.9 : at(toMinutes(cap.time));
            tl.to(caps[i], { autoAlpha: 1, y: 0, duration: 0.5, ease: "power2.out" }, inAt);
            const next = c.captions[i + 1];
            if (next) tl.to(caps[i], { autoAlpha: 0, y: -40, duration: 0.5, ease: "power2.in" }, at(toMinutes(next.time)) - 0.2);
          });

          tl.to("[data-part=phone]", { rotation: -2 * inlineSign(el), y: 10, duration: 0.8, ease: "power1.inOut" }, at(end))
            .addLabel("sunrise", at(end) + 0.6)
            .to("[data-part=sun]", { yPercent: -35, autoAlpha: 1, scale: 1.25, duration: 1.4, ease: "power2.out" }, "sunrise")
            .fromTo(
              "[data-part=dawn]",
              { clipPath: "circle(0% at 50% 100%)" },
              { clipPath: "circle(150% at 50% 100%)", duration: 1.2, ease: "power2.in" },
              "sunrise+=0.6",
            )
            .addLabel("covered")
            .fromTo("[data-part=dawn-text]", { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.8 }, "covered-=0.3")
            .addLabel("dusk", "+=0.8")
            .to("[data-part=dawn-text]", { autoAlpha: 0, y: -20, duration: 0.4, ease: "power1.in" }, "dusk")
            .to("[data-part=dusk]", { autoAlpha: 1, duration: 1, ease: "power1.inOut" }, "dusk")
            .addLabel("settled")
            .to({}, { duration: 0.3 });

          // Header follows what's under it: night → paper (dawn) → page theme (after dusk).
          const progressAt = (label: string) => tl.labels[label] / tl.duration();
          const toneAt = (p: number): HeaderTone =>
            p < progressAt("covered") - 0.02 ? "night" : p < progressAt("dusk") + 0.04 ? "paper" : "page";
          setHeaderTone("night");
          ScrollTrigger.create({
            trigger: el,
            start: "top top",
            end: () => `+=${Math.round(window.innerHeight * PIN_VIEWPORTS)}`,
            pin: true,
            scrub: SCRUB,
            animation: tl,
            invalidateOnRefresh: true,
            onUpdate: (st) => setHeaderTone(toneAt(st.progress)),
            onLeave: () => setHeaderTone("page"),
          });
        },
        lite: () => {
          toneWhileVisible();
          all("[data-part=cap]").forEach((cap) =>
            onceInView(cap, () => gsap.from(cap, { x: -12 * inlineSign(el), autoAlpha: 0, duration: 0.7, ease: "power3.out" }), "top 92%"),
          );
        },
        off: toneWhileVisible,
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  // Hero words, flattened so each gets its own stagger index for the intro.
  const lineWords = c.title.map((line) =>
    line.flatMap((part) => part.text.split(" ").map((word) => ({ word, em: part.em }))),
  );
  const titleLines = lineWords.map((words, li) => {
    const first = lineWords.slice(0, li).reduce((n, w) => n + w.length, 0);
    return words.map((w, i) => ({ ...w, index: first + i }));
  });

  return (
    <section ref={root} id="top" data-chapter={c.chapter} className={s.night}>
      <StarField className={s.stars} />
      <div className={s.sun} data-part="sun" aria-hidden />

      <div className={cn(s.wrap, s.nightInner)}>
        <div className={s.nightCopy}>
          <div className={s.heroCopy} data-part="hero-copy">
            <p className={cn("eyebrow", s.heroEyebrow, s.introFade)} style={stagger(0)}>
              {c.eyebrow}
            </p>
            <h1 className={s.heroTitle}>
              {titleLines.map((words, li) => (
                <span key={li} className={s.heroLine}>
                  {li > 0 ? " " : null}
                  {words.map((w, wi) => (
                    <span key={w.index}>
                      {wi > 0 ? " " : null}
                      <span className={cn(s.heroWord, s.intro, w.em && s.em)} style={stagger(w.index)}>
                        {w.word}
                      </span>
                    </span>
                  ))}
                </span>
              ))}
            </h1>
            <p className={cn(s.lede, s.heroLede, s.introFade)} style={stagger(1)}>
              {c.lede}
            </p>
            <div className={cn(s.heroActions, s.introFade)} style={stagger(2)}>
              <Button render={<a href={primary.href} />} size="lg" className="h-11 px-5">
                {primary.label}
                <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
              </Button>
              <Button
                render={<a href="#knowledge" />}
                variant="ghost"
                size="lg"
                className="h-11 px-5 text-[var(--night-foreground)] hover:bg-[var(--night-glass)] hover:text-[var(--night-foreground)]"
              >
                {c.howItWorks}
              </Button>
            </div>
            <p className={cn("eyebrow", s.heroNote, s.introFade)} style={stagger(3)}>
              {c.note}
            </p>
          </div>

          <ol className={s.captions} aria-label={c.captionsLabel}>
            {c.captions.map((cap) => (
              <li key={cap.time} className={s.cap} data-part="cap">
                <span className={cn("eyebrow", s.capTime)}>{cap.time}</span>
                <p className={s.capText}>
                  {cap.text}
                  {cap.em ? (
                    <>
                      {" "}
                      <b>{cap.em}</b>
                    </>
                  ) : null}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <div className={s.nightPhone}>
          <div className={s.introPhone}>
            <Phone night label={c.phoneLabel} data-part="phone">
              <StatusBar />
              <div className={s.lock}>
                <div className={cn("eyebrow", s.lockDay)}>{c.day}</div>
                <div className={s.lockTime}>
                  <span className={s.live1}>{newest.time}</span>
                  <span className={s.live2} data-part="clock">
                    {oldest.time}
                  </span>
                </div>
                <div className={s.unread}>
                  <b>
                    <span className={s.live1}>{UNREAD_BY_MORNING}</span>
                    <span className={s.live2} data-part="unread">
                      1
                    </span>
                  </b>
                  {c.unreadLabel}
                </div>
              </div>
              <div className={s.notifViewport}>
                <ul className={s.notifs}>
                  {c.notifications.map((n, i) => (
                    <li key={i} className={s.notifSlot} data-part="notif">
                      <div className={s.notifInner}>
                        <div className={cn(s.notif, n.lost && s.notifLost)}>
                          <span className={s.notifApp}>
                            <MessageCircle className={s.icon} />
                          </span>
                          <div>
                            <div className={s.notifTop}>
                              <b>{n.name}</b>
                              <span>{n.time}</span>
                            </div>
                            <p className={s.notifText}>{n.text}</p>
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </Phone>
          </div>
        </div>
      </div>

      <div className={s.dawn} data-part="dawn" aria-hidden>
        <div data-part="dawn-text">
          <p className="eyebrow">{c.dawnEyebrow}</p>
          <p className={cn(s.h2, s.dawnTitle)}>{c.dawnTitle}</p>
        </div>
        <div className={s.dusk} data-part="dusk" />
      </div>
      <div className={cn("eyebrow", s.scrollCue)} data-part="cue" aria-hidden>
        <span className={s.scrollCueBar} />
        {c.scrollCue}
      </div>
    </section>
  );
}
