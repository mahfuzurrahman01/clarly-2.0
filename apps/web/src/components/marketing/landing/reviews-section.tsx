import { cn } from "@/lib/utils";
import type { LandingContent, Review } from "@/lib/i18n/landing/types";
import s from "./landing.module.css";

/**
 * Two rows of review cards drifting in opposite directions (CSS only; pauses
 * on hover, wraps into a static grid under reduced motion). The rows are
 * forced LTR so the -50% loop works in Arabic too; each card keeps the page's
 * direction for its text. Each row renders twice so the loop is seamless —
 * the copy is hidden from assistive tech.
 */
export function ReviewsSection({ c, dir }: { c: LandingContent["reviews"]; dir: "ltr" | "rtl" }) {
  return (
    <section id="reviews" className={cn(s.sec, s.reviews)}>
      <div className={cn(s.wrap, s.secHead)}>
        <div>
          <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
          <h2 className={s.h2}>{c.title}</h2>
        </div>
        <span className={cn("eyebrow", s.sampleTag)}>{c.sample}</span>
      </div>
      <div className={s.marquee}>
        {c.rows.map((row, ri) => (
          <div key={ri} dir="ltr" className={cn(s.mqRow, ri === 1 && s.mqRowReverse)}>
            {row.map((r) => (
              <ReviewCard key={r.name} r={r} dir={dir} />
            ))}
            {row.map((r) => (
              <ReviewCard key={`dup-${r.name}`} r={r} dir={dir} duplicate />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function ReviewCard({ r, dir, duplicate }: { r: Review; dir: "ltr" | "rtl"; duplicate?: boolean }) {
  return (
    <figure dir={dir} className={cn(s.review, duplicate && s.mqDuplicate)} aria-hidden={duplicate || undefined}>
      <blockquote className={s.reviewQuote}>{dir === "rtl" ? `«${r.quote}»` : `“${r.quote}”`}</blockquote>
      <figcaption className={s.reviewBy}>
        <span className={cn(s.avatar, s.avatarSm)}>{r.initial}</span>
        <span>
          <b>{r.name}</b>
          <span>{r.role}</span>
        </span>
      </figcaption>
    </figure>
  );
}
