"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LandingContent, Plan } from "@/lib/i18n/landing/types";
import s from "./landing.module.css";

type Period = "monthly" | "yearly";

/** 08 · Pricing — early access (free, now) plus the planned tiers. */
/** Every plan button leads to the page's primary action (waitlist, or signup when it's off). */
export function PricingSection({ c, actionHref }: { c: LandingContent["pricing"]; actionHref: string }) {
  const [period, setPeriod] = useState<Period>("monthly");

  return (
    <section id="pricing" data-chapter={c.chapter} className={s.sec}>
      <div className={s.wrap}>
        <div className={s.secHead}>
          <div>
            <p className={cn("eyebrow", s.lime)}>{c.eyebrow}</p>
            <h2 className={s.h2}>{c.title}</h2>
            <p className={s.lede}>{c.body}</p>
          </div>
          <div className={s.period} role="group" aria-label={c.periodLabel}>
            {(["monthly", "yearly"] as const).map((p) => (
              <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>
                {c[p]}
                {p === "yearly" ? <small> · {c.yearlyNote}</small> : null}
              </button>
            ))}
          </div>
        </div>
        <div className={s.plans}>
          {c.plans.map((plan) => (
            <PlanCard key={plan.name} plan={plan} period={period} c={c} actionHref={actionHref} />
          ))}
        </div>
        <p className={s.priceNote}>{c.note}</p>
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  period,
  c,
  actionHref,
}: {
  plan: Plan;
  period: Period;
  c: LandingContent["pricing"];
  actionHref: string;
}) {
  const amount = plan.price?.[period];
  return (
    <article className={cn(s.plan, plan.featured && s.planFeatured)}>
      <div className={s.planHead}>
        <span>{plan.name}</span>
        {plan.badge ? <span className={s.badge}>{plan.badge}</span> : null}
      </div>
      <div className={s.price}>
        {amount === undefined ? (
          plan.priceLabel
        ) : (
          <>
            {c.currencyPosition === "before" ? `${c.currency} ` : null}
            <span className={s.priceAmount}>{amount}</span>
            {c.currencyPosition === "after" ? ` ${c.currency}` : null}
            <small>{c.perMonth}</small>
          </>
        )}
      </div>
      <p className={s.planDesc}>{plan.description}</p>
      <ul>
        {plan.features.map((f) => (
          <li key={f}>
            <Check className={s.icon} aria-hidden />
            {f}
          </li>
        ))}
      </ul>
      <Button
        render={<a href={actionHref} />}
        variant={plan.featured ? "default" : "outline"}
        size="lg"
        className={cn(s.planCta, "h-10")}
      >
        {plan.cta}
      </Button>
    </article>
  );
}
