"use client";

import { useRef } from "react";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WaitlistForm } from "@/components/marketing/waitlist-form";
import { cn } from "@/lib/utils";
import type { LandingContent } from "@/lib/i18n/landing/types";
import type { LandingAction } from "./landing-action";
import { WAITLIST_ANCHOR } from "./landing-action";
import { Phone, RichText, StatusBar } from "./phone";
import { countTo, gsap, inlineSign, landingMedia, onceInView, scoped, useGSAP } from "./motion";
import s from "./landing.module.css";

/** Messages waiting at 09:00 without Clarly — counted down to zero on reveal. */
const WAITING_WITHOUT = 47;

/**
 * Closing section: 09:00, the night's chats all handled, nothing waiting —
 * and the waitlist form. Without a Web3Forms key the form is hidden and the
 * section offers the signup action instead.
 */
export function CtaSection({
  c,
  waitlistAccessKey,
  fallback,
}: {
  c: LandingContent["cta"];
  waitlistAccessKey: string | null;
  fallback: LandingAction;
}) {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current!;
      const { one, all } = scoped(el);
      const reveal = () => {
        onceInView(one("[data-part=phone]"), () => {
          gsap.from(all("[data-part=chat]"), { autoAlpha: 0, x: 24 * inlineSign(el), stagger: 0.1, duration: 0.6, ease: "power3.out" });
          countTo(one("[data-part=waiting]"), 0, { from: WAITING_WITHOUT, duration: 1.4 });
        });
      };
      const mm = landingMedia(el, { full: reveal, lite: reveal });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <section ref={root} id={WAITLIST_ANCHOR} className={cn(s.sec, s.cta)}>
      <div className={cn(s.wrap, s.ctaGrid)}>
        <div>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.ctaTitle}>
            <RichText parts={c.title} />
          </h2>
          <p className={s.lede}>{c.body}</p>
          <div className={s.ctaForm}>
            {waitlistAccessKey ? (
              <WaitlistForm accessKey={waitlistAccessKey} />
            ) : (
              <Button render={<a href={fallback.href} />} size="lg" className="h-11 px-5">
                {fallback.label}
                <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
              </Button>
            )}
          </div>
        </div>
        <div className={s.ctaPhone}>
          <Phone label={c.phoneLabel} data-part="phone">
            <StatusBar time="09:00" />
            <div className={s.clistHead}>
              <b>{c.chatsTitle}</b>
              <span>
                <strong data-part="waiting">0</strong> {c.waitingLabel}
              </span>
            </div>
            {c.chats.map((chat) => (
              <div key={chat.name} className={s.clistItem} data-part="chat">
                <span className={s.avatar}>{chat.initial}</span>
                <div className="min-w-0">
                  <div className={s.clistName}>{chat.name}</div>
                  <div className={s.clistPreview}>{chat.preview}</div>
                </div>
                <div className={s.clistTime}>
                  {chat.time}
                  <Check className={s.icon} aria-hidden />
                </div>
              </div>
            ))}
          </Phone>
        </div>
      </div>
    </section>
  );
}
