# Clarly 2.0 — System Architecture

Status: **binding** for the v2 merge. Written 2026-10-06.
Companion docs: [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) (every feature, where it comes
from, where it lives now) · [CONFLICTS.md](./CONFLICTS.md) (every place the two products
disagreed and what was decided) · [AUTOLOGIC_AUDIT.md](./AUTOLOGIC_AUDIT.md) (production
weaknesses found in Autologic) · [SCALING_1K.md](./SCALING_1K.md) (capacity plan for the
first 1,000 subscribers) · [MANUAL_STEPS.md](./MANUAL_STEPS.md) (env vars and owner tasks) ·
[BUILD_LOG.md](./BUILD_LOG.md) (what v2 has shipped, stage by stage).

---

## 1. The decision in one paragraph

Clarly 2.0 is **one product** made from two:

- **Engine = Clarly v1.** Its codebase becomes the base: a TypeScript Turborepo with a NestJS
  API (`apps/api`) and a Next.js console + public site (`apps/web`), Postgres with **forced
  row-level security**, Drizzle migrations, BullMQ workers on Redis, ports-and-adapters around
  every vendor (LLM, embeddings, ASR, rerank, Meta, Stripe, stores, couriers), Sentry and an
  eval harness.
- **Product surface = Autologic ∪ Clarly.** Every customer-facing capability Autologic has in
  production (bookings with Google Calendar, the website chat widget, free-form broadcasts and
  follow-ups, the AI catalog assistant, URL import, the operator console, own-key AI, multi-provider
  AI, usage metering and plan limits, web push, Bangla) is re-implemented **as Clarly modules**,
  following Clarly's conventions (RLS, queues, zod DTOs, swagger, unit specs, HANDOFF entries).
- **UI = Clarly's design system** (paper / ink / lime, Hanken Grotesk + Fraunces, shadcn on
  base-ui, full Arabic RTL). Autologic screens are rebuilt in it; none of Autologic's inline-style
  React is copied.
- **Market = international, GCC first.** Arabic + English are first-class; Bangla is carried over
  as a third console locale; currency, timezone and locale are per-tenant settings, never
  hard-coded (Autologic hard-codes `Asia/Dhaka` in its booking prompt).

### Why the engine is Clarly and not Autologic

| Concern at 1,000 subscribers | Autologic (Next 14, JS, Vercel functions) | Clarly v1 (NestJS + workers) |
|---|---|---|
| Inbound message handling | LLM reply generated **inside the Meta webhook request**, debounced with `setTimeout` in a serverless function; only `entry[0].messaging[0]` of each delivery is read | Webhook verifies, dedups, persists, **enqueues**, returns 200; workers coalesce bursts and reply; every entry processed |
| Tenant isolation | Service-role key everywhere; isolation = remembering `.eq('client_id')` in ~46 routes | `FORCE ROW LEVEL SECURITY` on every tenant table + `withTenantTx()` that fails closed |
| Schema changes | Hand-run SQL in the Supabase editor, no migration history | 70 versioned migrations, journal, CI check |
| Rate limiting | In-memory per warm instance | Redis-backed webhook limiter; global limiter planned |
| Vendor failure | One provider per tenant, direct SDK calls | Ports + adapters, circuit breaker, rescue policy |
| Types / tests | Plain JS, 116 node scripts | TypeScript strict, 315 Jest specs, contract + integration + eval suites, 80% coverage gate |
| Observability | `console.log` (incl. raw webhook bodies with customer PII) | Sentry, telemetry module, agent-run traces |

Rewriting Clarly's guarded agent, tickets, store sync and RLS into Autologic's monolith would throw
away the stronger half. Porting Autologic's **features** onto Clarly's **engine** keeps both.

---

## 2. Runtime topology

```
                                   ┌───────────────────────────── Clients ─────────────────────────────┐
                                   │ Console + public site (Next.js, Vercel)   Website widget (widget.js)│
                                   │ Operator console (/platform, same app)    Mobile shell (PWA→Capacitor)│
                                   └──────────────┬──────────────────────────────────┬──────────────────┘
                                                  │ HTTPS (Supabase JWT)             │ HTTPS (widget key + Origin)
 Meta (WhatsApp Cloud API, Messenger, IG) ──────┐ │                                  │
 Stripe · Shopify/Woo/Salla/Zid · couriers ─────┤ ▼                                  ▼
 Google Calendar OAuth callbacks ───────────────┴► ┌─────────────────────────── API (NestJS, N replicas) ─────────────────┐
                                                   │ REST + webhooks + public widget endpoints. Stateless.               │
                                                   │ Verify signature → dedup → persist → ENQUEUE → 200 (< 1 s)          │
                                                   └──────────────┬─────────────────────────────────────────────────────┘
                                                                  │ BullMQ (Redis)
                                                   ┌──────────────▼──────────── Workers (same image, worker profile) ─────┐
                                                   │ respond-path · media-download · comments · campaigns · broadcasts     │
                                                   │ follow-ups · store-sync · shipment-poll · booking-reminders           │
                                                   │ re-embed · usage-rollup · webhooks-out · retention · billing-lifecycle│
                                                   └──────┬───────────────┬────────────────┬──────────────────┬───────────┘
                                                          ▼               ▼                ▼                  ▼
                                               Postgres 16 (Supabase)   Redis 7      Object storage      AI providers
                                               RLS + pgvector, PITR     queues,      (Supabase Storage)  Gemini / OpenAI /
                                               Supavisor txn pooling    limits,      KB files, product   DeepSeek / Qwen /
                                                                        caches       photos, exports     OpenRouter, Cohere rerank,
                                                                                                         ASR — platform key or BYOK
```

**One image, two profiles.** `apps/api` already supports a lean worker profile
(`queue-worker-profile.provider.ts`). Production runs the same build twice: `web` processes
(HTTP only, no consumers) and `worker` processes (consumers only). They scale independently:
HTTP on request rate, workers on queue depth.

**Hosting (recommended, see SCALING_1K.md for sizing):** console on Vercel; API + workers as
containers on Railway / Fly.io / Render (or ECS later); Supabase Postgres (Pro + compute
add-on, in an EU or Middle-East region close to GCC users); a Redis with persistence (Railway
Redis, Redis Cloud or ElastiCache — **not** a per-request-billed Redis, BullMQ polls
constantly); Cloudflare in front of the API for DNS, TLS and WAF.

---

## 3. Core flows

### 3.1 Inbound message (WhatsApp / Messenger / Instagram / website widget)

1. Channel webhook (or `POST /widget/v1/messages`) arrives at the API.
2. Signature verified (Meta HMAC; widget: per-tenant widget key + `Origin` allow-list + IP/key
   rate limit). **No signature, no processing** — v2 never skips verification because a secret
   is missing (Autologic does).
3. Dedup by provider message id (`webhook_message_dedup`), tenant resolved from the channel,
   message persisted inside `withTenantTx`.
4. A respond-path job is enqueued with a stable job id; the HTTP request returns.
5. Worker coalesces the burst (several quick messages = one turn), loads conversation + policy,
   runs the agent loop: retrieval (KB passages + rerank), tools (`lookup_product`,
   `create_order`, `track_order`, **`check_availability`, `book_appointment`** new in v2),
   guardrails (off-limits, distress, injection, safety lexicon), confidence → reply or hand-off.
6. Reply sent through the channel adapter; usage event written (tokens, model, cost, provider,
   `byok` flag) for metering and the operator's cost view.

The widget differs only at the edges: the browser polls (or holds an SSE stream) for the reply
instead of receiving it through Meta.

### 3.2 Hand-off

Clarly's ticket model is the one kept: low confidence, off-limits topic, distress, explicit
request, or a deterministic safety hit opens a ticket, the agent goes silent, one holding reply
is sent, the team is notified (in-app, email, **web push** new in v2), a stuck ticket escalates.
Autologic's EN/BN/Banglish "I want a person" lexicon is merged into the guardrail lexicon.

### 3.3 Bookings (new in v2, from Autologic "agency")

`booking` module. A tenant with the **services** vertical (or any tenant that enables it)
defines services (name, duration, buffer, price) and opening hours, connects Google Calendar
(OAuth, signed one-shot state). The agent gets two tools: `check_availability(service, date)`
(free/busy against the tenant's calendar in the tenant's timezone) and `book_appointment(...)`
(idempotent per turn; creates the calendar event with a Meet link when the service is online;
writes `bookings`; notifies the team). Reminders run on a queue. A tenant without a calendar
still gets bookings as **requests** that a human confirms.

### 3.4 Broadcasts and follow-ups (new in v2, from Autologic)

Clarly's campaigns send **approved templates** to segments with consent and a spend cap. v2
adds what Autologic does: **free-form broadcasts** to people whose last inbound message is
inside Meta's 24-hour window (no template needed, no spend), and **automatic follow-ups** on
conversations that went quiet, also only inside the window. Anyone outside the window is shown
as "needs a template" rather than silently dropped.

### 3.5 Catalog assistant (new in v2, from Autologic "AI Assistant")

The merchant talks to an assistant in the console ("add 3 new abayas from these photos", "mark
all size 54 out of stock"). It **proposes** a change set; nothing is written until the merchant
confirms; the apply step re-validates every change server-side. Photo drafts (vision reads the
photos before anything is saved), duplicate detection (code > name > photo fingerprint) and URL
import (scrape a product page) feed the same proposal → confirm → apply pipeline.

---

## 4. Module map (apps/api)

Existing Clarly modules stay as they are. v2 adds:

| Module | Owns | Source |
|---|---|---|
| `platform` | Operator console API: tenants list/detail, suspend/resume, plan assignment, usage + AI cost, platform AI provider switch, manual payment review. Guarded by `platform_admins`, never by tenant roles. | Autologic `/admin` |
| `usage` | `usage_events` (every AI call, priced), daily rollup, plan-limit checks, near-limit (90%) signals | Autologic `usage_daily`, `plan-limits`, `entitlements` |
| `ai-keys` | Tenant own-key (BYOK): verify with provider, encrypt (AES-256-GCM), store masked, hard cost separation | Autologic `client_ai`, `crypt.js` |
| `booking` | Services, hours, Google Calendar connection, bookings, tools, reminders | Autologic agency mode, `gcal.js` |
| `widget` | Website channel: widget keys, allowed origins, public message endpoints, embed script config | Autologic `widget.js`, `public/widget.js` |
| `broadcast` | Free-form 24h-window broadcasts, recipient ledger with real platform errors | Autologic `broadcast*.js` |
| `followup` | Quiet-conversation follow-ups inside the window | Autologic `followup*.js` |
| `catalog-assistant` | Proposal/confirm/apply for catalog changes, photo drafts, duplicate sweep, URL import | Autologic `inventory-*`, `photo-*`, `duplicates.js`, `scrape-products.js` |
| `push` | Web Push (VAPID) + FCM device registry, per-user subscriptions | Autologic `push.js`, `fcm.js` |
| `tags` (in `customer`) | Free-form tags on customers, used by segments | Autologic `tags.js` |

Every new tenant table: `tenant_id uuid NOT NULL`, composite FKs where rows reference other
tenant rows, `ENABLE` + `FORCE ROW LEVEL SECURITY` with the standard `app.tenant_id` policy,
indexes leading with `tenant_id`. Every new module is registered in `modules/index.ts` and
`AppModule` (the module-graph spec enforces it).

---

## 5. Tenancy, identity and roles

| Actor | Identity | Scope |
|---|---|---|
| Operator (us) | Supabase user listed in `platform_admins` (`owner` / `staff` / `viewer`) | `/platform/*` API and console. Reads across tenants through an audited service path; every write is in `audit_log` with `actor_kind = 'platform'`. |
| Tenant admin | Supabase user, `app_metadata.tenant_id`, role `admin` | Everything inside the tenant |
| Tenant agent | Same, role `agent` | Inbox, tickets, orders, bookings, catalog read |
| End customer | Channel identity (wa_id, PSID, IGSID, widget visitor id) | Never logs in |

Autologic's "one login = one client" becomes "one workspace, many seats". Autologic's
`business_type` becomes the tenant **vertical** (`commerce` | `services` | `hybrid`): it picks
onboarding defaults, which nav items show first and which tools are seeded — it no longer forks
the prompt into two locked variants.

---

## 6. AI layer

- **Ports stay** (`LlmProvider`, `VisionProvider`, `Embedder`, `Transcriber`, `Reranker`).
  v2 adds `openai` and `openrouter` adapters next to Gemini, DeepSeek and Qwen.
- **Platform provider** is chosen by the operator (one active chat provider at a time, as
  Autologic enforces with a unique index), with circuit-breaker failover to a configured
  secondary.
- **BYOK**: a tenant on an own-key plan runs generation (chat, vision, ASR) **only** on its own
  key. A missing or broken key pauses the bot and alerts the owner; it is never silently routed
  to the platform key (Autologic's hard cost-separation rule, kept).
- **Embeddings are always platform-owned** and every vector row records the model that made it,
  so search compares like with like (the rule Autologic learned the hard way). Changing the
  embedding model triggers the background re-embed job (`db:reembed` becomes a queue job).
- **Metering**: every call writes a priced `usage_events` row (`model_prices` table owned by the
  operator) → plan limits, near-limit banners, operator margin view.

---

## 7. Internationalisation

- Console locales: `en`, `ar` (RTL, default for GCC visitors), `bn` (added). Dictionaries stay
  typed (`en.ts` is the source of truth; other locales must satisfy its type).
- Per-tenant `default_locale`, `timezone` (IANA), `currency` (ISO 4217). Bookings, reports and
  reminders use the tenant timezone; prices use the tenant currency.
- The agent answers in the customer's language (Arabic dialects, Arabizi, English, Bangla,
  Banglish, others the model handles); Autologic's Bangla-specific prompt rules move into a
  locale-scoped prompt section rather than a global fork.

---

## 8. Billing

- **Stripe is primary** (cards, Apple Pay / Google Pay; Mada where Stripe supports it in KSA).
- The plan catalogue moves from Stripe-only rows to a richer `plans` table: limits for replies /
  month, products, KB documents, assistant questions, channels, seats; monthly and yearly price;
  own-key price; trial days. The operator edits it in `/platform/plans`.
- A `BillingProvider` port already exists. v2 adds a `manual` provider (bank transfer / mobile
  wallet reference, operator approves in `/platform/payments`) so markets without Stripe still
  work; an `sslcommerz` adapter can follow for Bangladesh. One function applies a confirmed
  payment, whichever provider confirmed it (Autologic's `activatePaymentRow` rule).
- ZATCA e-invoicing is a launch blocker for paid KSA customers (see SCALING_1K.md §6).

---

## 9. Non-functional targets (launch)

| Target | Bar |
|---|---|
| Webhook ack | p99 < 1 s |
| Agent reply (text, no tools) | p95 < 5 s |
| Availability | 99.9% monthly for API + workers |
| Data loss on region failure | RPO ≤ 5 min (PITR), RTO ≤ 4 h |
| Cross-tenant leak | 0 (RLS + integration tests + red team) |
| Duplicate replies | 0 (dedup + stable job ids) |

How these are reached and paid for: [SCALING_1K.md](./SCALING_1K.md).
