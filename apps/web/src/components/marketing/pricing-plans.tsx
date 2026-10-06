"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Check } from "lucide-react";
import { type PublicPlanRecord, listPublicPlans } from "@/lib/api/billing";
import { ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal } from "@/components/marketing/aura/reveal";
import { Spotlight } from "@/components/marketing/aura/spotlight";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { LandingAction } from "@/components/marketing/landing/landing-action";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; plans: PublicPlanRecord[] };

/**
 * The public catalog carries no billing interval, so two plan rows that differ
 * only by their (hidden) Stripe price read as the same plan twice. Show each
 * distinct offer once, first row wins.
 */
function uniquePlans(plans: PublicPlanRecord[]): PublicPlanRecord[] {
  const seen = new Set<string>();
  return plans.filter((plan) => {
    const signature = [
      plan.name.trim().toLowerCase(),
      plan.monthlyMessageLimit,
      plan.monthlySpendCapUsd,
      plan.trialDays,
    ].join("|");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

/**
 * Real plan catalog from `GET /billing/plans`, with loading/error states.
 * `action` is where each plan's button leads (signup, or the waitlist during
 * the waitlist-only launch).
 */
export function PricingPlans({ t, action }: { t: Dictionary; action: LandingAction }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Bumping this re-runs the fetch effect below — the "Try again" button's
  // retry mechanism, driven from an event handler rather than the effect
  // itself synchronously resetting state.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    listPublicPlans()
      .then((plans) => {
        if (alive) setState({ status: "ready", plans: uniquePlans(plans) });
      })
      .catch((err) => {
        if (alive) {
          setState({
            status: "error",
            message: err instanceof ApiError ? err.message : t.pricing.errorBody,
          });
        }
      });
    return () => {
      alive = false;
    };
  }, [attempt, t.pricing.errorBody]);

  function retry() {
    setState({ status: "loading" });
    setAttempt((a) => a + 1);
  }

  if (state.status === "loading") {
    return (
      <div
        className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        role="status"
        aria-label={t.pricing.loadingPlans}
      >
        {[0, 1, 2].map((i) => (
          <Spotlight key={i} className="flex min-h-64 flex-col gap-3 p-7">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="mt-auto h-10 w-full" />
          </Spotlight>
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-14 flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border bg-card/40 p-8 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle className="size-4" />
          {t.pricing.errorTitle}
        </div>
        <p className="text-sm text-muted-foreground">{state.message}</p>
        <Button variant="outline" size="sm" onClick={retry}>
          {t.pricing.retry}
        </Button>
      </div>
    );
  }

  const { plans } = state;

  if (plans.length === 0) {
    return (
      <div className="mt-14 rounded-2xl border border-dashed border-border bg-card/40 p-8 backdrop-blur text-center">
        <p className="text-sm font-medium">{t.pricing.noPlansTitle}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t.pricing.noPlansBody}</p>
      </div>
    );
  }

  return (
    // Centered rows, so one or two plans don't leave empty columns.
    <div className="mt-14 flex flex-wrap justify-center gap-6">
      {plans.map((p, i) => (
        <Reveal key={p.id} index={i} className="w-full sm:w-[calc(50%-0.75rem)] lg:w-[calc((100%-3rem)/3)]">
          <Spotlight lift className="flex h-full flex-col gap-5 p-7">
            <p className="font-display text-2xl font-medium tracking-tight">{p.name}</p>
            <ul className="space-y-2.5 text-sm text-muted-foreground">
              <li className="flex items-center gap-2.5">
                <Check className="size-4 shrink-0 text-lime-text" aria-hidden />
                {p.monthlyMessageLimit.toLocaleString()} {t.billing.perMonthMessages}
              </li>
              <li className="flex items-center gap-2.5">
                <Check className="size-4 shrink-0 text-lime-text" aria-hidden />
                {t.billing.spendCapTemplate.replace(
                  "{cap}",
                  p.monthlySpendCapUsd.toLocaleString(),
                )}
              </li>
              {p.trialDays > 0 ? (
                <li className="flex items-center gap-2.5 font-medium text-lime-text">
                  <Check className="size-4 shrink-0" aria-hidden />
                  {t.billing.trialDaysTemplate.replace("{days}", String(p.trialDays))}
                </li>
              ) : null}
            </ul>
            <Button render={<Link href={action.href} />} size="lg" className="mt-auto h-11 w-full">
              {action.label}
              <ArrowRight className="size-4 rtl:-scale-x-100" />
            </Button>
          </Spotlight>
        </Reveal>
      ))}
    </div>
  );
}

