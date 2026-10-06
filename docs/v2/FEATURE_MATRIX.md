# Clarly 2.0 — Feature Matrix

Every capability of Autologic (A) and Clarly v1 (C), what v2 does with it, where it lives, and
the build stage. Stage numbers refer to the plan at the end of this file. Status is updated in
[BUILD_LOG.md](./BUILD_LOG.md) as stages land; this file records the **decision**.

Legend — **Keep C**: Clarly's implementation stays. **Port A**: rebuilt from Autologic's behaviour
on Clarly's engine. **Merge**: both contribute. **Defer**: decided, not in the first v2 release.

## Conversations and AI

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Answers from business documents (RAG) | ✅ (agency only) | ✅ with citations + rerank | Keep C | `knowledge-base`, `retrieval` | — |
| Product answers from catalog | ✅ (ecommerce only) | ✅ `lookup_product` | Keep C | `catalog` | — |
| Photo → product match | ✅ (per-photo fingerprints + vision verify) | ✅ vision | Merge: C pipeline + A's "never confidently wrong" photo verify rule | `catalog`, `agent/media` | S7 |
| Voice notes | ✅ Gemini | ✅ pluggable ASR | Keep C | `llm` | — |
| Confidence hand-off, tickets, kanban | ❌ (`[[HANDOFF]]` flag only) | ✅ | Keep C | `ticket`, `kanban` | — |
| "Wants a human" lexicon EN/BN/Banglish | ✅ | ✅ AR/EN | Merge lexicons | `guardrail` | S1 |
| Off-limits topics, distress, injection guard, safety escalation | partial (locked prompts) | ✅ | Keep C | `guardrail` | — |
| Locked base rules (FIXED_BASE/ECOM/AGENCY) | ✅ | policy sections | Merge: A's rules become C prompt sections, gated by vertical/tools | `prompt` | S1 |
| Business profile generated from an interview | ✅ `generate-prompt` | partial (agent config) | Port A | `agent-config` | S5 |
| Offer rewrite (promo copy) | ✅ | ❌ | Port A (small) | `agent-config` | S5 |
| Playground | ❌ | ✅ | Keep C | web `/playground` | — |
| Evals | ❌ | ✅ | Keep C | `apps/api/eval` | — |
| Bot on/off per conversation, per channel | ✅ | ✅ (handover) | Keep C + per-channel pause from A | `conversation`, `channel` | S4 |

## Channels

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| WhatsApp Cloud API, Embedded Signup, coexistence echoes | ✅ | ✅ | Keep C | `whatsapp`, `connect` | — |
| Messenger + Instagram DMs | ✅ | ✅ | Keep C | `meta-channel` | — |
| FB/IG comment auto-reply + DM | ✅ | ✅ rules + classifier | Keep C | `comments` | — |
| **Website chat widget** | ✅ live | ❌ (Goal 12 not started) | **Port A** | `widget` + `apps/web/public/widget.js` | S3 |
| Telegram | ❌ (stub removed) | ❌ | Defer | — | — |
| Channel token health / reconnect | ✅ daily cron | ✅ WA health + reconnect | Keep C, extend to Pages | `whatsapp/health` | S4 |

## Commerce

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Catalog CRUD, CSV, images, variants | ✅ | ✅ | Keep C, add A's variant axes | `catalog` | S7 |
| **AI catalog assistant (chat → confirm → apply)** | ✅ | ❌ | **Port A** | `catalog-assistant` | S7 |
| **Photo batch → product drafts, photo grouping** | ✅ | ❌ | **Port A** | `catalog-assistant` | S7 |
| **Duplicate sweep (code > name > photo)** | ✅ | ❌ | **Port A** | `catalog-assistant` | S7 |
| **Import a product from a URL (scrape)** | ✅ | ❌ | **Port A** | `catalog-assistant` | S7 |
| Store sync Shopify / WooCommerce / Salla / Zid | one-shot import (Woo, Shopify) | ✅ OAuth sync + webhooks | Keep C | `store` | — |
| Orders in chat, approval gate | ✅ (JSON in reply) | ✅ tool + approval modes | Keep C | `order` | — |
| Courier tracking (Aramex, SMSA, Naqel, J&T) | ❌ | ✅ | Keep C | `courier` | — |

## Services (Autologic "agency")

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| **Bookings / appointments** | ✅ | ❌ | **Port A**, as tools not JSON-in-text | `booking` | S2 |
| **Google Calendar free/busy + event + Meet link** | ✅ | ❌ | **Port A** behind a `CalendarProvider` port | `booking` | S2 |
| Services catalogue (duration, price) | ❌ (free text) | ❌ | New in v2 | `booking` | S2 |
| Booking reminders | ❌ | ❌ | New in v2 (queue) | `booking` | S2 |

## Growth and messaging

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Template campaigns, segments, consent, spend cap | ❌ | ✅ | Keep C | `campaign` | — |
| **Free-form broadcasts inside the 24 h window** | ✅ | ❌ | **Port A** | `broadcast` | S4 |
| **Automatic follow-ups on quiet chats** | ✅ | ❌ | **Port A** | `followup` | S4 |
| **Customer tags** | ✅ | labels (Hot/Warm/Cold) | Merge: keep labels, add tags | `customer` | S4 |
| Intake fields | ❌ | ✅ | Keep C | `agent-config` | — |

## Workspace, team and insight

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Team seats Admin / Agent | ❌ (single login) | ✅ | Keep C | `auth`, web `/settings/team` | — |
| Insights, knowledge gaps, first-response time | basic analytics | ✅ | Keep C | `metrics`, `outcomes` | — |
| Notification bell | ✅ (rich feed) | ✅ | Keep C, add A's event kinds | `notifications` | S8 |
| **Web push + native push** | ✅ VAPID + FCM | ❌ | **Port A** | `push` | S8 |
| Global search | ✅ | ❌ | Port A | web shell | S8 |
| Audit log, outbound webhooks, data export, offboarding, retention | ❌ | ✅ | Keep C | existing modules | — |
| Meta data deletion / deauthorize | ✅ | ✅ | Keep C | `privacy` | — |

## Billing and plans

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Stripe checkout, dunning, entitlement guard | ❌ | ✅ | Keep C (primary) | `billing`, `billing-lifecycle` | — |
| **Plan catalogue with limits (replies, products, docs, assistant, channels, seats)** | ✅ | message limit + spend cap only | **Merge** | `billing` + `usage` | S1 |
| **Usage metering of every AI call, priced** | ✅ | telemetry only | **Port A** | `usage` | S1 |
| Near-limit (90%) warnings | ✅ | ❌ | Port A | `usage` + web banner | S1 |
| Own-key (BYOK) plans at a lower price | ✅ | ❌ | Port A | `ai-keys`, `billing` | S6 |
| Manual payment (txn reference, operator approves) | ✅ (bKash etc.) | ❌ | Port A as `manual` provider | `billing`, `platform` | S9 |
| SSLCommerz | ✅ | ❌ | Defer (adapter slot exists) | `billing` | later |
| Slider "basket" pricing, prorated top-ups | ✅ | ❌ | Defer: Stripe quantity add-ons after launch | `billing` | later |
| Refund requests | ✅ | ❌ | Defer (Stripe refunds via operator) | `platform` | later |

## Operator (super admin)

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| **Operator console: tenants, detail, suspend, plan** | ✅ | ❌ (scripts only) | **Port A** | `platform` + web `/platform` | S5 |
| **Platform AI provider switch (one active)** | ✅ | env vars | **Port A** | `platform` + `llm` | S6 |
| **Model price list, AI cost and margin view** | ✅ | ❌ | **Port A** | `usage` + `platform` | S5 |
| Meta webhook subscription checker | ✅ | ❌ | Port A | `platform` | S5 |
| Catalogue health per tenant | ✅ | ❌ | Port A | `platform` | S7 |
| Operator → tenant email | ✅ | ❌ | Port A | `platform` + `email` | S5 |
| Blog with AI writer | ✅ | ❌ | Defer (marketing site concern) | — | later |
| White-label partner domains | ✅ | ❌ | Defer (brand per tenant for widget only in S3) | — | later |

## Surfaces

| Feature | A | C | v2 decision | v2 home | Stage |
|---|---|---|---|---|---|
| Public landing, pricing, product, legal, waitlist | ✅ (TellMore) | ✅ (Clarly, AR-first) | Keep C | `apps/web` | — |
| Public help manual (EN/BN) | ✅ | ❌ | Port A content as `/help` (EN/AR first) | `apps/web` | S9 |
| Bangla console | ✅ | ❌ | Port A as third locale | `apps/web/lib/i18n` | S1 |
| PWA install | ✅ | ❌ | Port A | `apps/web` | S8 |
| Android apps (user + admin, Capacitor) | ✅ | ❌ (Goal 12) | Defer to after web parity; same shell approach | `apps/mobile` | later |

## Build stages

| Stage | Scope |
|---|---|
| S0 | Seed clarly2.0 from Clarly v1, vendor SheetJS, write these docs |
| S1 | Foundations: tenant profile (vertical, timezone, currency, locale), `platform_admins`, `usage_events` + `model_prices`, plan limits, near-limit signal, Bangla locale scaffold, merged hand-off lexicon |
| S2 | Bookings: services, hours, Google Calendar connector, `check_availability` / `book_appointment` tools, reminders, console pages |
| S3 | Website widget channel: keys, origins, public API, embed script, console settings |
| S4 | Broadcasts (24 h), follow-ups, tags, per-channel pause |
| S5 | Operator console: tenants, plans, usage + cost, operator email, webhook checker |
| S6 | BYOK + OpenAI / OpenRouter adapters + platform provider switch |
| S7 | Catalog assistant, photo drafts, duplicates, URL import, catalogue health |
| S8 | Web push, notification kinds, global search, PWA |
| S9 | Manual payment provider, help center, mobile shell |
