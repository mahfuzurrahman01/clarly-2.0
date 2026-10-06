# WhatsApp Message Templates

> Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview — fetched 2026-09-26

## Categories

Three categories, each with different pricing and review scrutiny:

- **Authentication** — OTP/verification codes. Template-only (can't be sent as session messages). Highest scrutiny for exact wording.
- **Marketing** — promotions, offers, re-engagement, proactive outreach. Template-only. Highest per-message rate. Subject to per-user marketing-message caps set by Meta (frequency limits to reduce spam).
- **Utility** — transactional (order updates, receipts, reminders, appointment confirmations). Cheaper than marketing; historically free when sent inside the 24h customer service window (see `pricing-conversations.md` for the Oct 2026 change to this).

Miscategorizing a template (e.g., marketing content submitted as utility) risks rejection or later re-categorization by Meta, which triggers a `template_category_update` webhook — handle that webhook if this SaaS lets tenants author templates, since pricing/behavior changes underneath them.

## Approval process

- Templates are submitted via the Template Management API (`POST /<WABA_ID>/message_templates`) or WhatsApp Manager UI.
- Automatic review typically completes within 24 hours; status becomes `APPROVED`, `REJECTED`, or stays `PENDING`.
- Only `APPROVED` templates can be sent.
- Rate limit: max 100 template creations per WABA per hour.
- Template count limits: 250–6,000 per WABA depending on the business's verification tier — relevant if this SaaS's tenants are on unverified/lower tiers and hit creation caps.

## Quality rating (per-template, not per-WABA)

Based on user engagement signals — blocks, reports, read rate, negative feedback:

- **High Quality** — minimal negative feedback.
- **Medium Quality** — some negative feedback / lower read rates, still sendable.
- **Low Quality** — at risk; Meta may pause the template.
- **Paused** → if quality doesn't recover, **Disabled**.

This is distinct from the phone number's own quality rating (which affects messaging-limit tiers) — a single bad template can get paused without affecting the number's overall rating, but repeated bad templates will drag the number rating down too.

## Management API essentials

- `POST /<WABA_ID>/message_templates` — create.
- `GET /<WABA_ID>/message_templates` — list/retrieve, including current status and quality rating.
- Update content or category via API or WhatsApp Manager — editing a template resets its review/approval state.
- Auto-archival: templates unused for 12+ months are archived, then deleted after 28 days unless restored — if this SaaS pre-provisions template libraries per tenant, add a periodic check to keep needed templates "warm" or accept re-creation cost.

## Sources

- https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
