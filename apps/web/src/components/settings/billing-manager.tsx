"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import {
  type MonthlyUsageResult,
  type PlanRecord,
  type TenantSubscriptionRecord,
  cancelSubscription,
  getSubscription,
  openBillingPortal,
  startCheckout,
} from "@/lib/api/billing";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function BillingManager({
  usage,
  subscription: initialSubscription,
  plans,
  email,
}: {
  usage: MonthlyUsageResult | null;
  subscription: TenantSubscriptionRecord | null;
  plans: PlanRecord[];
  email: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [subscription, setSubscription] = useState(initialSubscription);
  const [portalPending, setPortalPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const plan = plans.find((p) => p.id === subscription?.planId);

  // Stripe Checkout return: `?checkout=success|cancelled`. Surface it,
  // refetch subscription state (the webhook may already have landed), and
  // strip the query param so a refresh/share doesn't re-toast.
  useEffect(() => {
    const checkout = searchParams.get("checkout");
    if (!checkout) return;

    if (checkout === "success") {
      toast.success(t.billing.checkoutSuccessNotice);
      trackFunnelEvent({ name: "checkout_completed" });
      getSubscription()
        .then((sub) => {
          setSubscription(sub);
          if (sub?.status === "active") {
            trackFunnelEvent({ name: "subscription_paid", planId: sub.planId });
          }
        })
        .catch(() => {
          // Best-effort refresh — the page's own initial fetch already ran,
          // and a manual reload will pick up the confirmed state either way.
        });
    } else if (checkout === "cancelled") {
      toast.info(t.billing.checkoutCancelledNotice);
      trackFunnelEvent({ name: "checkout_cancelled" });
    }

    const next = new URLSearchParams(searchParams);
    next.delete("checkout");
    router.replace(
      next.size > 0 ? `/settings/billing?${next.toString()}` : "/settings/billing",
      { scroll: false },
    );
  }, [searchParams, router, t]);

  async function manage() {
    setPortalPending(true);
    try {
      const { portalUrl } = await openBillingPortal(window.location.href);
      window.location.href = portalUrl;
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.billing.couldNotOpenPortal));
      setPortalPending(false);
    }
  }

  async function cancel(atPeriodEnd: boolean) {
    if (!atPeriodEnd && !confirm(t.billing.cancelImmediatelyConfirm)) return;
    setCancelPending(true);
    try {
      const updated = await cancelSubscription(atPeriodEnd);
      setSubscription(updated);
      toast.success(
        atPeriodEnd && updated.currentPeriodEnd
          ? t.billing.cancelledTemplate.replace(
              "{date}",
              formatDate(updated.currentPeriodEnd, locale),
            )
          : t.billing.cancelledImmediatelyTemplate,
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.billing.couldNotCancel));
    } finally {
      setCancelPending(false);
    }
  }

  async function subscribe(planId: string) {
    setCheckoutPlanId(planId);
    trackFunnelEvent({ name: "checkout_started", planId });
    try {
      const origin = window.location.origin;
      const { checkoutUrl } = await startCheckout(
        planId,
        email,
        `${origin}/settings/billing?checkout=success`,
        `${origin}/settings/billing?checkout=cancelled`,
      );
      window.location.assign(checkoutUrl);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.billing.couldNotStartCheckout));
      setCheckoutPlanId(null);
    }
  }

  const statusLabel = subscription
    ? subscription.cancelAtPeriodEnd
      ? t.billing.statusCancelling
      : {
          trialing: t.billing.statusTrialing,
          active: t.billing.statusActive,
          past_due: t.billing.statusPastDue,
          canceled: t.billing.statusCanceled,
          incomplete: t.billing.statusIncomplete,
        }[subscription.status]
    : null;

  return (
    <div className="space-y-8">
      {/* Usage */}
      {usage ? (
        <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
          <h2 className="font-display text-lg font-medium tracking-tight">
            {t.billing.usageTitle}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.billing.usagePeriodTemplate
              .replace("{from}", formatDate(usage.periodStart, locale))
              .replace("{to}", formatDate(usage.periodEnd, locale))}
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-4">
            <Stat label={t.billing.messages} value={usage.messageCount.toLocaleString()} />
            <Stat label={t.billing.inputTokens} value={usage.inputTokens.toLocaleString()} />
            <Stat label={t.billing.outputTokens} value={usage.outputTokens.toLocaleString()} />
            <Stat
              label={t.billing.estimatedCost}
              value={`$${usage.totalCostUsd.toFixed(2)}`}
              accent
            />
          </div>
        </section>
      ) : null}

      {/* Subscription */}
      <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.billing.subscriptionTitle}
        </h2>

        {subscription ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{plan?.name ?? subscription.planId}</span>
              {statusLabel ? (
                <span
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs",
                    subscription.status === "past_due"
                      ? "border-destructive/40 bg-destructive/5 text-destructive"
                      : subscription.cancelAtPeriodEnd
                        ? "border-border text-muted-foreground"
                        : "border-lime-ring/40 bg-lime-soft/70 text-lime-text",
                  )}
                >
                  {statusLabel}
                </span>
              ) : null}
            </div>

            <p className="text-sm text-muted-foreground">
              {subscription.trialEndsAt && subscription.status === "trialing"
                ? t.billing.trialEndsTemplate.replace(
                    "{date}",
                    formatDate(subscription.trialEndsAt, locale),
                  )
                : subscription.currentPeriodEnd
                  ? (subscription.cancelAtPeriodEnd
                      ? t.billing.endsTemplate
                      : t.billing.renewsTemplate
                    ).replace("{date}", formatDate(subscription.currentPeriodEnd, locale))
                  : null}
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button variant="outline" onClick={manage} disabled={portalPending}>
                {portalPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ExternalLink className="size-4" />
                )}
                {t.billing.managePlan}
              </Button>
              {!subscription.cancelAtPeriodEnd && subscription.status !== "canceled" ? (
                <Button
                  variant="outline"
                  className="text-destructive hover:bg-destructive/10"
                  onClick={() => cancel(true)}
                  disabled={cancelPending}
                >
                  {cancelPending ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t.billing.cancelSubscription}
                </Button>
              ) : null}
              {subscription.status === "active" && !subscription.cancelAtPeriodEnd ? (
                <button
                  type="button"
                  onClick={() => cancel(false)}
                  disabled={cancelPending}
                  className="text-xs text-muted-foreground underline hover:text-destructive disabled:opacity-50"
                >
                  {t.billing.cancelImmediatelyInstead}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-1">
            <p className="text-sm font-medium">{t.billing.noSubscriptionTitle}</p>
            <p className="text-sm text-muted-foreground">{t.billing.noSubscriptionBody}</p>
          </div>
        )}
      </section>

      {/* Plans — only relevant when not already subscribed */}
      {!subscription ? (
        <section>
          <h2 className="font-display text-lg font-medium tracking-tight">
            {t.billing.plansTitle}
          </h2>
          {plans.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
              <p className="text-sm font-medium">{t.billing.noPlansTitle}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t.billing.noPlansBody}</p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {plans.map((p) => (
                <Card key={p.id}>
                  <CardContent className="flex h-full flex-col gap-3">
                    <p className="font-display text-xl font-medium tracking-tight">{p.name}</p>
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      <li>
                        {p.monthlyMessageLimit.toLocaleString()} {t.billing.perMonthMessages}
                      </li>
                      <li>
                        {t.billing.spendCapTemplate.replace(
                          "{cap}",
                          p.monthlySpendCapUsd.toLocaleString(),
                        )}
                      </li>
                      {p.trialDays > 0 ? (
                        <li>
                          {t.billing.trialDaysTemplate.replace("{days}", String(p.trialDays))}
                        </li>
                      ) : null}
                    </ul>
                    <Button
                      onClick={() => subscribe(p.id)}
                      disabled={checkoutPlanId !== null}
                      className="mt-auto"
                    >
                      {checkoutPlanId === p.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : null}
                      {t.billing.subscribe}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <p className="eyebrow text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 font-display text-2xl font-medium tracking-tight",
          accent && "text-lime-text",
        )}
      >
        {value}
      </p>
    </div>
  );
}
