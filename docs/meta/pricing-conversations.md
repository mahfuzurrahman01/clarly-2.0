# WhatsApp Business Platform Pricing (Conversation → Per-Message Model)

> Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing — fetched 2026-09-26. Some October 2026 figures below are corroborated by third-party industry coverage (Blueticks, EngageLab, CM.com) rather than direct quotes from the official page at fetch time — the official page had not yet been observed to reflect the Oct 1 2026 change wording at the time of this fetch; re-verify the official page directly closer to that date.

## The model shift (already in effect)

Since **1 July 2025**, Meta bills **per delivered template message**, not per 24-hour "conversation" — the old Conversation-Based Pricing (CBP) conversation-unit model is retired for template sends. Non-template (session) messages sent inside an open 24-hour customer service window remain free.

## Categories and current behavior

| Category | Billed when | Notes |
|---|---|---|
| Marketing | Always | Highest rate in every market; template-only |
| Authentication | Outside customer service window | Free within window (as of this fetch); template-only |
| Utility | Outside customer service window | Free within window (as of this fetch) |
| Service (agent replies within 24h) | Not billed (as of this fetch) | Free-form, no template needed |

Illustrative rates reported: **~$0.0250/message** for US marketing, **~$0.0034/message** for US utility (per third-party pricing trackers — confirm current rate in Meta's pricing calculator per-market before using in billing logic, rates are country/category-tier specific).

Volume tiers: businesses unlock lower utility/authentication rates as monthly send volume increases, aggregated across the whole Business Portfolio (not per-WABA), reset monthly, and tier boundaries are market+category-specific.

## Upcoming: 1 October 2026 changes (verify against official page before this date)

Multiple industry sources report that starting **2026-10-01**, Meta will begin **charging for utility templates and service messages sent inside the 24-hour window** — ending free-in-window billing for those categories. If accurate, this is a meaningful cost-model change for any SaaS (like this one) that relies on utility templates/service replies inside the window being free. **Action item: re-fetch developers.facebook.com/.../whatsapp/pricing shortly before Oct 1 2026 and update this file and any billing/cost-estimation logic in the codebase accordingly.**

Also reported for the same window:
- Standalone rate restructuring for specific markets — Bangladesh, Iraq, Nepal, Sri Lanka get new lower utility/auth rates plus a new "authentication-international" rate; Kazakhstan, Kuwait, Morocco, Oman, Ukraine see higher rates in these categories.
- Brazil gets local BRL billing (invoicing through Meta's local entity) from 2026-07-01.

## Meta Business Agent (AI messaging) pricing — separate track

Reported: a new per-token "Meta Business Agent" AI message category launching **2026-08-01**, priced around **$2.00 per 1M tokens** (~4-5 cents per typical AI-generated message). This is Meta's own agent platform pricing, not necessarily applicable to this SaaS's own LLM costs, but worth tracking if Meta later ties any WhatsApp-side AI features to it.

## Additional cost layer

Any BSP (Business Solution Provider) markup on top of Meta's raw per-message rate — typically **$0.003–$0.010/message** for larger BSPs. If this SaaS is a direct Tech Provider (not going through a BSP), this line item may not apply; confirm the integration model in `meta-graph/`.

## Action items for this codebase

- Whatever cost-tracking/billing logic exists (or is planned) for tenant WhatsApp usage should key off the `pricing` block in the status webhook (`category`, `billable`, `pricing_model` — see `webhooks.md`) rather than hardcoding rates, since rates are market+tier+time dependent.
- Flag the Oct 1 2026 window-billing change as a TODO to re-check pricing assumptions before that date lands.

## Sources

- https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- https://blueticks.co/blog/whatsapp-business-pricing-change-2026-per-message
- https://blueticks.co/blog/whatsapp-business-api-pricing-2026
- https://www.engagelab.com/blog/whatsapp-business-api-pricing
- https://www.cm.com/blog/whatsapp-business-platform-pricing/
