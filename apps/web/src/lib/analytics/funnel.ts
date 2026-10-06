/**
 * Typed seam for the revenue funnel the former launch plan asked the
 * frontend to instrument (sequencing now in docs/GULF_PARITY_PLAN.md):
 * signup -> checkout -> number connected -> first AI reply -> paid.
 *
 * No analytics provider (PostHog/Segment/GA/etc.) is wired into apps/web
 * yet, so this is intentionally a no-op — call sites can be added now and
 * the body swapped for a real `provider.track(...)` call later without
 * touching anything upstream. Keeping it typed also means a rename or
 * payload change to one event is a compile error everywhere it's fired,
 * not a silently-broken analytics event.
 */
export type FunnelEvent =
  | { name: "signup_completed"; tenantId: string }
  | { name: "checkout_started"; planId: string }
  | { name: "checkout_completed" }
  | { name: "checkout_cancelled" }
  | { name: "whatsapp_number_connected"; numberId: string }
  | { name: "first_ai_reply"; conversationId: string }
  | { name: "subscription_paid"; planId: string };

/**
 * Fire a funnel event. No-op until a provider is wired up — see module
 * doc comment. Safe to call from client or server code.
 */
export function trackFunnelEvent(event: FunnelEvent): void {
  // Intentionally empty: no analytics provider configured yet. Referencing
  // `event` keeps the parameter's shape enforced by the type checker at
  // every call site without tripping unused-argument lint rules.
  void event;
}
