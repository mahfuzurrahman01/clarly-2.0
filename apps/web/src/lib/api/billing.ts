import { apiFetch, browserApiFetch } from "./client";

export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type PlanRecord = {
  id: string;
  name: string;
  stripePriceId: string;
  monthlyMessageLimit: number;
  monthlySpendCapUsd: number;
  trialDays: number;
};

/** `GET /billing/plans/public` — the catalog minus Stripe internals. */
export type PublicPlanRecord = Omit<PlanRecord, "stripePriceId">;

export type TenantSubscriptionRecord = {
  id: string;
  tenantId: string;
  planId: string;
  /** Null for a local no-card trial that hasn't been through Checkout. */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  /** True once cancelled but the paid period hasn't run out yet — status stays "active" the whole time. */
  cancelAtPeriodEnd: boolean;
  /** Operator-granted entitlement (set by script only); counts as paid. */
  comped: boolean;
};

export type MonthlyUsageResult = {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
};

/** Pass `token` from a server component; omit it in the browser. Admin-only. */
export function listPlans(token?: string) {
  const path = "/billing/plans";
  return token
    ? apiFetch<PlanRecord[]>(path, { token })
    : browserApiFetch<PlanRecord[]>(path);
}

/** For the public, signed-out `/pricing` page — unauthenticated endpoint. */
export function listPublicPlans() {
  return apiFetch<PublicPlanRecord[]>("/billing/plans/public");
}

export function getUsage(token?: string) {
  const path = "/billing/usage";
  return token
    ? apiFetch<MonthlyUsageResult>(path, { token })
    : browserApiFetch<MonthlyUsageResult>(path);
}

/** `null` means the tenant has never started checkout — normal pre-billing state, not an error. */
export function getSubscription(token?: string) {
  const path = "/billing/subscription";
  return token
    ? apiFetch<TenantSubscriptionRecord | null>(path, { token })
    : browserApiFetch<TenantSubscriptionRecord | null>(path);
}

// --- Mutations (browser only — driven by user actions) ---

export function startCheckout(
  planId: string,
  email: string,
  successUrl: string,
  cancelUrl: string,
) {
  return browserApiFetch<{ checkoutUrl: string }>("/billing/checkout", {
    method: "POST",
    json: { planId, email, successUrl, cancelUrl },
  });
}

export function openBillingPortal(returnUrl: string) {
  return browserApiFetch<{ portalUrl: string }>("/billing/portal", {
    method: "POST",
    json: { returnUrl },
  });
}

export function cancelSubscription(atPeriodEnd: boolean) {
  return browserApiFetch<TenantSubscriptionRecord>("/billing/cancel", {
    method: "POST",
    json: { atPeriodEnd },
  });
}

// --- Derived entitlement helpers (frontend-side; mirror BACKEND_PLAN.md D7/D8 semantics) ---

/**
 * Mirrors the API's `BillingService.hasPaidSubscription()` (the D7 gate on
 * WhatsApp connect): comped, or a completed Stripe Checkout whose
 * subscription is still active/trialing. A local no-card signup trial has
 * `stripeSubscriptionId: null`; a canceled/past_due subscription keeps its id
 * but no longer counts.
 */
export function hasCardOnFile(
  subscription: TenantSubscriptionRecord | null | undefined,
): boolean {
  if (!subscription) return false;
  if (subscription.comped) return true;
  return (
    subscription.stripeSubscriptionId !== null &&
    (subscription.status === "active" || subscription.status === "trialing")
  );
}

/**
 * Days left in a local or Stripe trial, or a negative/zero number once it
 * has lapsed. `null` when the tenant isn't in a trial at all (no
 * subscription row, or `status` isn't `trialing`) — the backend never flips
 * a local trial's `status` away from `trialing` on its own (no webhook for
 * it), so "expired" has to be derived here from `trialEndsAt` vs. now.
 */
export function trialDaysRemaining(
  subscription: TenantSubscriptionRecord | null | undefined,
): number | null {
  if (!subscription || subscription.status !== "trialing" || !subscription.trialEndsAt) {
    return null;
  }
  const msRemaining = new Date(subscription.trialEndsAt).getTime() - Date.now();
  return Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
}
