# Deferred Work

Tracked here per [BACKEND_PLAN.md](./BACKEND_PLAN.md)'s Deferred section and the 2026-08-12 plan gap review. Each item: what it is, why it's deferred (not an oversight), and the gate that unblocks it. Do not start any of these without the gate condition being true — if the gate looks met, raise it for re-prioritization rather than silently starting.

## Ready to start (no gate — scoped and briefed)

### Four order-history segment criteria threw instead of compiling (F19 × F25) — RESOLVED 2026-09-22
`order_count`, `order_total_usd`, `last_order_within_days` and `never_ordered` were accepted by
F19's segment grammar but threw `SegmentCriterionNotImplementedError` in `segment-compiler.ts`:
F19 and F25 were built concurrently and F19 deliberately did not couple to an `orders` table that
did not exist in `schema.ts` yet (recorded in the F19 HANDOFF entry's "Not yet available", not as
its own item here — this entry closes it in both places).

- **Gate was:** F25's `orders` table exists in `schema.ts`. **Fired** with commit `2cf5d85`
  (F25 orders + complaints), migration `0059_orders.sql`.
- **Resolved by:** all four criteria now compile to correlated subqueries over `orders`, scoped by
  `orders.tenant_id = customers.tenant_id AND orders.customer_id = customers.id`, counting **only**
  `REALISED_ORDER_STATUSES` (`confirmed`, `fulfilled`) per F19 D1 — a `pending_approval`,
  `rejected`, `expired`, `cancelled` or `failed` order is not a purchase. See the
  `docs/HANDOFF.md` entry *F19 × F25 — order-history segment criteria*.
- **Still open, carried forward:** the D9 plan gate
  (`test/integration/campaign-segment-plan.integration-spec.ts`) asserts "no `Seq Scan`" for
  `customers` and `customer_labels` only; the `orders` half was skipped while these criteria threw
  and is now unblocked. F19 D1 also names `orders_tenant_created_idx (tenant_id, created_at DESC)`
  as required from F25; F25 shipped `orders_tenant_status_created_idx (tenant_id, status,
  created_at DESC)` instead, which these criteria do not use. No new index was added here — see the
  HANDOFF entry's index note.

### Store OAuth state is replayable within its TTL (no nonce)
Raised by the Phase 6 review, 2026-09-22. `StoreOAuthStateService.verify()` checks signature,
audience, expiry and provider, but nothing marks a state single-use, so one state completes the
callback repeatedly until it expires. For the redirect providers (Salla/Zid/Shopify) the state only
ever lives in a browser URL. F24's WooCommerce flow hands it to the *merchant's* WordPress install
as the `user_id` param, where it is persisted in their database and echoed back by their server —
more copies, in more places, for longer. Anyone holding it inside the TTL can
`POST /store/callback/woocommerce` with an arbitrary key pair and re-bind that tenant's connection to
attacker-chosen credentials. The host stays pinned by the signed state, so this is credential
substitution, not host hijack. Fix: a one-shot nonce claimed at callback time (the
`store_webhook_events` claim-row pattern already in this module is the obvious precedent). Not a
Phase 6 blocker — the pre-existing behaviour is unchanged; F24 widened the exposure.

### P5 dev webhook simulator is not tenant-scoped
`DEV_SIMULATOR_PHONE_NUMBER_ID` is one fixed env var, so `POST /api/dev-simulator`
always resolves to whichever tenant owns that `phone_number_id` in
`whatsapp_numbers` — verified 2026-09-05 QA pass: a signed-in admin from a
brand-new workspace ("QA Test Workspace") fired the simulator and the message
landed on an unrelated, pre-existing dev tenant instead. The UI copy was fixed
(2026-09-05, ISSUE-006) to stop implying it lands in the current workspace, but
the underlying cross-tenant routing is unchanged.
- **Not gated** — surfaced by the 2026-09-05 QA pass (item #17 of the former
  QA checklist, removed 2026-09-19; see [docs/GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md)).
- **Needs:** either (a) look up the *calling admin's own tenant's* connected
  WhatsApp number and use that `phone_number_id` instead of the env var,
  falling back to a clear error when the tenant has none, or (b) accept this
  as permanently dev-single-tenant-only and leave the honest-copy fix as the
  final state. Genuine per-tenant fix depends on a self-serve WhatsApp
  connect flow existing — now F21 (Embedded Signup, T3) in
  [GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md) Phase 2 (a workspace needs
  *some* way to have a real `whatsapp_numbers` row before the simulator could
  target it specifically).

### Tenant name read endpoint (for the console sidebar) — RESOLVED 2026-08-22
Shipped as `GET /onboarding/tenant` (HANDOFF `Tenant directory — GET /onboarding/tenant`)
and threaded through the console session: `components/shell/app-shell.tsx` now renders
`tenantName`. Kept below for history.

No endpoint returns the tenant's own name. The console previously rendered
`tenantId.slice(0, 8)` as workspace identity — a hex fragment. The R1 shell
replaced it with the Clarly wordmark, so nothing is broken, but the workspace a
person is signed into is still unnamed anywhere in the UI, which matters as soon
as anyone belongs to more than one.
- **Not gated** — surfaced by the 2026-08-19 frontend design review.
- **Needs:** a tenant-scoped read (`GET /onboarding/tenant` or equivalent)
  returning at least `{ id, name }`, callable by the `agent` role and not just
  `admin` — the sidebar renders for both. `GET /onboarding/tenant-policy` is
  the closest existing endpoint and is admin-only, so it cannot be reused.
- **Then:** thread it through `getConsoleSession()` and render it above the
  wordmark in `components/shell/app-shell.tsx`.
- Requires a `docs/HANDOFF.md` entry per CLAUDE.md.

### Confidence-threshold calibration — RESOLVED 2026-08-16 (B1), verified 2026-08-31
The 2026-08-16 morning run failed false escalation at 46.2% (mean confidence 0.189 vs a 0.5 threshold) while recall@5 was 100%, hallucinations 0, missed escalations 0 — a scoring bug, not retrieval or model quality. Root cause and fix are in `docs/decisions/A0-production-readiness-assessment.md` **B1**: `escalation-decision.ts` took `min(model_self_report, retrieval_support_score)`, so an uncalibrated RRF/reranker relevance score (~0.19) dominated the composite and threw away correct, cited, correctly-answered turns. Fix (Round 2, committed): retrieval support is now a **gate** (floor `RETRIEVAL_SUPPORT_FLOOR = 0`, zero/fabricated citations still force 0), and above the floor the model's own confidence carries the decision. Result moved false escalation 42.3% → 1.3% and resolution 57.7% → 98.8%, pinned by `escalation-decision.spec.ts`. A fresh full run 2026-08-31 (161 cases, threshold 0.5, rerank off) reconfirms: `avgConfidenceResolved` ~1.0, hallucinations 0, leaks 0 — remaining false escalations are retrieval `KB_NOT_INDEXED`, nondeterministic `LLM_ERROR`, and a known multi-doc arithmetic-compose miss, none the old B1 pathology.
- **Also fixed (B3):** the eval scorer's false positive is gone — leak detection is now against verbatim L0 fragments (`PROMPT_LEAK_NEEDLES` in `eval/scoring.ts`, asserted verbatim by `scoring.spec.ts`), applied to every case, and topic words like `"system prompt"` are out of `eval/corpora/adversarial/cases.json`. A correct refusal no longer scores as a leak.
- **CLOSED 2026-09-22 — latency (B2):** decided in
  [docs/decisions/B2-retrieval-latency.md](./docs/decisions/B2-retrieval-latency.md). The remote
  query-embed round trip is 80-92% of retrieval p95; `CachingEmbedder` now removes it for repeated
  queries, and relocating the embedding host is deferred behind a gate that only pilot traffic can
  answer. Original note follows.
- **WAS OPEN — latency (B2):** latency p95 misses T9's <5000ms bar on slow-infra runs (5564ms Round 1; 3032ms with rerank off; 7370ms on the degraded 2026-08-31 run). Dominant cost is the retrieval embedding round-trip to the remote host over the Cloudflare tunnel (retrieval p95 has ranged 639ms→4615ms), **not** the reranker — rerank is already off by default (B2 recommendation, no recall loss). Remaining pass needs a warm/local embedding host or a faster served model; may need a product call. Own gate: none — pick up as a latency task, not a calibration one.

## P1 — deferred with an explicit gate

### Resolution-rate eval/benchmark suite
Formal eval harness (golden question sets, regression scoring) proving the agent-quality wedge claim, not just tracking a trend metric.
- **Why deferred:** needs real production tenant data to be meaningful — synthetic data won't surface real failure modes, and building it against imagined traffic risks optimizing for the wrong distribution.
- **Gate (rewritten 2026-09-19, D15a in [GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md)):**
  Feature 3 (AI Agent Core) has shipped (it has) **and** Gulf pilot tenants have
  real conversation volume. The pilots are the real tenant data this gate asks
  for: they start after paid launch (plan Phase 4) and this suite runs on their
  traffic as plan **Phase 5 item 2**. The previous wording ("at least one tenant
  has real conversation volume") had no path to satisfaction before F19/F20,
  which it also blocked; D15a resolves that loop by moving F20 after launch.
- **Discharged when:** the suite has run on pilot traffic at least once and is a
  CI signal, and the F17 vision/voice corpora have been rerun (Phase 5 exit).
- **Progress 2026-09-08:** the modality half is done — `vision-product`,
  `voice-support` and `media-unreadable` corpora now run real image/audio bytes
  through the real `AgentRuntime`, and the first baseline is recorded in
  `docs/decisions/F17-eval-baseline.md`. That run surfaced a blocking defect
  (the modality pre-pass pushes turns past `AGENT_LOOP_DEADLINE_MS`, so voice
  and image turns false-escalate as `LLM_ERROR (deadline_exceeded)`), which is
  exactly the signal the gate existed to produce. The gate is **not** discharged
  by this alone: golden-set regression scoring against real tenant traffic is
  still outstanding, and this defect should be fixed before F19/F20 start.
- **Blocking gate for F20 and F19** (locked 2026-09-06 eng review, re-sequenced 2026-09-19 by D15a): Product Catalog (F20, plan **Phase 6**) and Campaigns/Broadcast (F19, plan **Phase 7**) in [GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md) both send/answer against F17's unbenchmarked vision-derived data at scale — F19 in particular reaches many customers per send — so neither starts until this suite has run on Phase 5 pilot traffic at least once, not just once Feature 3 ships.

### Multi-provider LLM failover (automatic runtime switching)
Automatic failover across LLM vendors when the primary is degraded (as opposed to D2's circuit breaker, which fails *closed* to human escalation, not to a second provider).
- **Why deferred:** D2's breaker already converts the SPOF from "silent failure" to "degraded but correct" for ~half a day of work; true failover (a second adapter, health-check routing, response-format normalization across vendors, cost-consistency) is materially more work and needs vendor reliability signal to size correctly. The `LlmProvider` port (D1 in [AI_PIPELINE_PLAN.md](./AI_PIPELINE_PLAN.md)) ships with only the `GeminiProvider` adapter today, specifically kept swappable so adding a second vendor later is an adapter build, not a rewrite.
- **Gate:** either a real Gemini outage incident, or >2 tenants requesting provider choice as a purchasing requirement.

### Multi-channel beyond WhatsApp/Facebook/Instagram (phone voice calls, SMS, web chat widget)
- **Why deferred:** WhatsApp-only v1 was the original wedge; channel expansion before the core agent-quality bet is proven dilutes focus.
- **Gate:** Feature 3 exit criteria met and resolution-rate trend is positive for ≥1 full quarter. **This gate has not fired.**
- **Partial override, 2026-09-05:** FB Messenger + Instagram DM were pulled forward into Feature 16 (backend shipped; connect UI and go-live are now F22 in [GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md) Phase 2) on an explicit competitive-scope decision (LazyChat and Nodi both ship unified FB/IG/WhatsApp inboxes today), not because the gate condition was met. Recorded here so this doesn't read as "the resolution-rate trend proved out" — it didn't, because Feature 3 hasn't shipped yet. Phone voice calls, SMS, and a web chat widget remain deferred behind the original gate; only FB/IG moved. The web chat widget is now listed as optional F29 in plan Phase 8, built only if pilots ask; phone voice and SMS are not in the plan.

### Image/voice message understanding (v1 was detect + escalate only)
- **Status: promoted to Feature 17, 2026-09-05, and shipped for WhatsApp** — no longer deferred. FB/IG media (still escalated today) is F22/T6 in [GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md) Phase 2; the F17 corpora rerun is Phase 5 item 2. Was never gated in TODOS.md (it shipped as an explicit "not this round" line in the former feature plan/BACKEND_PLAN.md instead); pulled in for the same competitive reason as the multi-channel item above — LazyChat's headline claim is product-image recognition. See BACKEND_PLAN.md's A11/A12 for the task detail.

### Pre-built connector marketplace (tenants' external CRMs — Salesforce, HubSpot, etc.)
Distinct from T13's `CustomerModule`, which is our own built-in CRM, not this.
- **Why deferred:** demand-first — building generic connectors speculatively is the classic "feature parity with Wati/Respond.io" trap this plan explicitly rejects.
- **Gate:** a paying tenant blocks on a specific connector; build that one connector, not a generic marketplace.

## P2 — flagged in the 2026-08-12 gap review, deferred pending a decision or signal

### Subprocessor / DPA formalization for AI vendors
Tenant KB content and customer messages leave the system to Gemini (LLM *and* embeddings — both migrated from DeepSeek/OpenAI on 2026-08-15) and Cohere (rerank). No subprocessor list, DPA, zero-retention configuration, or data-residency note exists yet.
- **Why deferred:** legal review hasn't been scoped; premature to draft without counsel input on applicable jurisdictions.
- **Gate:** hard requirement before go-live in any GDPR/CCPA-applicable region — do not defer past first paying tenant in such a region. See BACKEND_PLAN.md's retention section.
- **Now tracked as plan Phase 0.2** ([GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md), 2026-09-19): legal counsel drafts ToS, Privacy Policy, DPA and the subprocessor list (Gemini, Cohere, self-hosted inference host, Meta), plus a **Saudi PDPL / data-residency** review of the LLM subprocessors (D15d). It blocks Meta app config (0.3) and paid launch (Phase 4), which makes it a launch requirement for the GCC target market regardless of the GDPR/CCPA gate above.

### Tenant-scale target for D3 (pgvector → Qdrant migration trigger)
D3 accepts pgvector now with an exit trigger at >500 tenants or retrieval p95 >400ms. Whether the 12-month plan is expected to exceed 500 tenants changes whether that migration cost should be paid now instead.
- **Why deferred:** this is a business/growth-projection call, not an engineering one — needs a number from whoever owns the 12-month tenant target.
- **Gate:** resolve before Feature 2.5 finalizes the `kb_chunks` partition DDL, since that's the point of no easy return.

### Throughput target definition (T9 amendment)
The plan states a latency budget (p95 <5s) but no throughput target — no expected messages/sec per tenant or platform-wide. Feature 2's load-shaped exit criteria (webhook flood, per-tenant starvation) and the Upstash per-command cost projection (Feature 0 note in the former feature plan, carried in `docs/decisions/F0-infra.md`) both need a number to test against.
- **Why deferred:** it's a business volume estimate, not an engineering derivation — needs whoever owns tenant/usage projections.
- **Gate:** resolve before Feature 2's verify steps run; a rough number (peak msgs/min per tenant × tenant count) is sufficient.

### RBAC beyond fixed Admin/Agent roles
T14 ships exactly two roles. Custom/configurable roles (e.g. "billing-only admin," "read-only viewer") are out of scope.
- **Why deferred:** no signal yet that two roles are insufficient; building configurable RBAC speculatively is the same trap as the connector marketplace.
- **Gate:** an enterprise tenant makes it a purchasing requirement.

### Frontend has no automated test suite
`apps/web` has no vitest/jest/playwright config — regression coverage for
frontend fixes (e.g. the 2026-09-01 `/qa` Select-label fixes) relies entirely
on manual browser QA.
- **Why deferred:** out of scope for the QA session that found it; needs a
  deliberate framework choice (see `/qa`'s Test Framework Bootstrap flow).
- **Gate:** next `/qa` run, or before the frontend surface grows past what
  manual QA can reasonably cover each time.

## QA findings — deferred 2026-09-24

From the frontend QA route sweep in `.gstack/qa-reports/qa-report-frontend-2026-09-24.md`. All "not fixed" — see that report for full repros and investigation detail.

- **[CRITICAL] Local dev DB migration state stuck (root cause of most below)** — `drizzle.__drizzle_migrations` caps around index 47-50 of 63 migration files; `drizzle-kit migrate` reports success but silently applies nothing (timestamp/hash drift in the tracking table). Missing `segments`, `campaigns`, `products` tables and `tenant_policy.campaignDefaultSpendCapUsd` column cascade into every issue below. **Gate:** repair migration-tracking state (or reset + clean remigrate), then re-run the QA sweep.
  - Repro: `psql` against local dev DB shows tables/columns missing; `pnpm --filter api db:migrate` / `drizzle-kit migrate` report success with zero rows applied.

- **[HIGH] "Open board" link on /home leads to broken /tickets (ApiError: Internal server error)** — `GET /kanban/tickets/config` 500s (missing `tenant_policy` column).
  - Repro: go to `/home` → click "Open board" under Tickets card (or go to `/tickets` directly) → "Couldn't load the board" error + console `ApiError: Internal server error`.

- **[CRITICAL] /campaigns fully broken — server-side 500 on load** — missing `campaigns` table.
  - Repro: `browse goto http://localhost:3000/campaigns` → HTTP 500, only "Try again"/"Back to home" render.

- **[HIGH] /campaigns "Try again" does not recover the page** — click-timeout symptom fixed, but retry still fails because the backend keeps 500ing.
  - Repro: click "Try again" on the /campaigns error screen → same error screen reappears; console shows fresh `ApiError: Internal server error`.

- **[CRITICAL] /campaigns/audiences always renders generic error boundary** — missing `segments` table (feature is named "segments" backend-side, not "audiences" — not actually unimplemented).
  - Repro: `browse goto http://localhost:3000/campaigns/audiences` → 500, error boundary only.

- **[HIGH] /campaigns/audiences "Try again" does not recover the page (regression reintroduced)** — matches previously-fixed-then-reverted bug (`04f5591`/`f8faa7d`).
  - Repro: click "Try again" on the error screen → identical error screen returns; retry mechanism itself works (fresh console entries per click) but backend endpoint keeps 500ing.

- **[LOW] Dev console error "Encountered a script tag while rendering React component" blocks clicks via overlay** — upstream `next-themes` v0.4.6 + React 19 incompatibility (`apps/web/src/app/layout.tsx:83`), known open issue (`pacocoursey/next-themes` #385/#387). Dev-only, no prod impact; no minimal safe fix available without masking console errors or replacing `next-themes`.
  - Repro: load any route in dev mode with the overlay showing; clicking an underlying button times out until Escape dismisses the overlay.

- **[CRITICAL] /campaigns/new fails to load — server-side 500** — missing `segments`/`campaigns`/etc. tables.
  - Repro: `browse goto http://localhost:3000/campaigns/new` → HTTP 500, error boundary only.

- **[HIGH] /campaigns/new "Try again" does not recover the page** — same DB-layer cause; frontend `error.tsx` patch already tried and reverted twice on this branch (`04f5591`/`f8faa7d`, `d324a06`/`3dd5eb4`).
  - Repro: click "Try again" → stays on error boundary; no new successful fetch.

- **[CRITICAL] /catalog fails to load — ApiError: Internal server error** — missing `products` table; migration tracking rows 49/50 have corrupted `created_at` timestamps that fool drizzle-kit into thinking 0051-0062 are already applied. A dry-run of `0051_products-catalog.sql` applies cleanly (confirmed fix), but requires a real DB write not performed here.
  - Repro: `browse goto http://localhost:3000/catalog` → "Couldn't load the catalog" error card.

- **[HIGH] /catalog "Try again" does not recover the page** — retry mechanism itself works; backend genuinely 500s every time (missing `products` table).
  - Repro: click "Try again" on the catalog error card → identical error text returned by `browse text`.

- **[LOW] Separate, unrelated migration bug: `0062_message-template-waba.sql` references column `waba_id` outside its subquery's alias scope** — will block a full `db:migrate` once the tracking corruption above is fixed. Flagged for awareness only; does not affect the routes tested here directly.

- **[HIGH] Not authenticated — redirect-to-login false positives across protected routes** — `/deliveries`, `/insights`, `/playground`, `/settings` and all `/settings/*` subpages, `/stores` all redirected the QA `browse` session to `/login`. Each of these routes is already correctly listed in `PROTECTED_PREFIXES` (`apps/web/src/lib/supabase/middleware.ts`) — this is the auth guard working as designed, not an app bug. Root cause is a QA-harness session-setup gap (no authenticated cookie in the `browse` session), matching the already-reverted `/deliveries` fix (`a0cd816` → `5b63c2e`).
  - **Gate:** authenticate the `browse` session (e.g. via `/setup-browser-cookies` or a real login step) before the next QA sweep of protected routes, then re-run to confirm these are true negatives.

## Known accepted risks (not deferred work, just documented)

- **LLM provider outage** remains a SPOF — only one adapter (Gemini) is built, nothing to fail over to yet (see failover item above). D2's circuit breaker is the current mitigation.
- **pgvector at scale** — accepted per D3 until the exit trigger fires.

## Untracked store stock → nullable `stock` (architect decision, 2026-10-01)

Decision: `stock: number | null` (null = not tracked); `stockStatus` stays the availability signal. Rejected: sentinel number (leaks to LLM/"has only 9999" messages), separate flag (can contradict). **Code implemented 2026-10-01** (port, 4 adapters, migration `0065`, shared `isOrderable`, webhook null fix, lookup_product guidance, web display; see HANDOFF entry "untracked store stock"). Remaining:
- Trigger a store resync per connection (no backfill).
- Re-run the L2 commerce eval (lookup_product guidance changed).
- Verify live: Salla null `quantity` meaning, Shopify `inventoryItem.tracked`, Zid `is_infinite`/`quantity`.
**Gate:** Salla live connect working.

## Shopify: public distribution and App Store items (deferred 2026-10-03)

The Shopify adapter was aligned with `docs/integrations/SHOPIFY.md` on 2026-10-03 (see the HANDOFF entry "Shopify adapter aligned with verified Shopify API") for a **custom-distribution** app on a dev store. These gap-table rows were left out on purpose because custom apps don't need them:
- **Expiring offline tokens (gaps 1, 2).** Send `expiring=1`, store `refresh_token`/`expires_in`, refresh about 60 s early and once on a 401, store the rotated pair, never refresh while a code grant runs for the same shop, and treat 401 `invalid_request` as re-authorize. Required for public apps created after 2026-04-01, and for all public apps from 2027-01-01. `ShopifyStoreProvider.refreshAccessToken` still returns null.
- **Compliance webhooks (gap 22).** `customers/data_request`, `customers/redact` and `shop/redact`, configured in TOML or the Dev Dashboard only. Return 401 on a bad HMAC and act within 30 days.
- **Install started from Shopify (gap 23).** An `application_url` handler that verifies `hmac`, resolves the tenant without our state, and starts OAuth straight away. App Store 2.3.1 also forbids our "type your shop domain" console input. The request shape is UNVERIFIED.
- **Protected customer data review (gap 10)** for phone, address and name, plus `read_all_orders` approval if orders older than 60 days are needed.
- **Webhook routing on `X-Shopify-Shop-Domain` (gap 19)**, if subscriptions move to TOML (one URI for all shops).

**Gate:** before public distribution (any Shopify app other than custom distribution).

### Shopify first live test (custom distribution, dev store)
None of the 2026-10-03 changes has been called against a live Shopify store. To check on the first run:
- the callback `hmac` verifies against a real redirect;
- the granted `scope` matches;
- the four `webhookSubscriptionCreate` calls succeed (or log `userErrors`) and deliveries arrive on `/store/webhook/shopify/<shop>`;
- `customers(query:"phone:+E164")` finds orders, including guest checkouts;
- the draft order accepts `phone` and an address with no `countryCode`/`city`;
- `inventory_levels/update` re-syncs (watch the load: one full connection re-sync per event burst, guarded per process only);
- `app/uninstalled` disconnects the connection.

**Gate:** a custom-distribution Shopify app and dev store exist (none yet: SHOPIFY.md "Our Shopify app").

## Zid: order creation, App Market uninstall, first live test (deferred 2026-10-03)

The Zid adapter was aligned with `docs/integrations/ZID.md` on 2026-10-03 (HANDOFF entry "Store — Zid adapter aligned with docs.zid.sa"). Three items were left open on purpose:

### Zid order creation (ZID.md gap 7)
`createOrder` throws `ZidOrderInputError` before calling Zid. `POST /v1/managers/store/drafts` requires `shipping_method {type, id}` (one of the store's delivery options), a structured `consignee.address` (`line_1`, `line_2`, `city_name`, ISO `country_code`), `customer.email`, products by `sku`, and a ZidPay payment-link `payment_method.id`. Our order carries a free-text address, an optional city, no email and no shipping method, and the port passes the store product id, not the SKU. Inventing any of these would put a wrong order in the merchant's store. Today every Zid order push fails and the merchant gets the "enter it in your store by hand" notification.
To close it: decide how the order gets a shipping method (merchant default in settings, or ask the customer, from List Store Shipping Methods: docs.zid.sa/list-store-delivery-options.md), collect or confirm email handling (Validate Order says `email` may be null; Create Order says required — test it), split the address, resolve SKUs (catalogue `sku` is synced), then pick the ZidPay method from List Payment Methods (`code: "payment_link.zidpay"`) and validate with `POST /v1/managers/store/drafts/validate` first.
**Gate:** a Zid dev store exists to test the drafts endpoint against, and a product decision on shipping-method selection.

### Zid App Market uninstall (ZID.md gap 11)
`app.market.application.uninstall` already normalizes to `app_uninstalled` (which disconnects), but Zid sends App Market events to the ONE endpoint set in the Partner Dashboard (Webhooks section), with optional custom auth headers, not to our per-store `/store/webhook/zid/<storeId>` route with its Basic credentials. Needs: an app-level route (e.g. `POST /store/webhook/zid-app`), an app-level secret header configured in the dashboard and checked in constant time, and a lookup that disconnects every active connection with `provider = 'zid'` and `store_id = payload.store_id` (across tenants, admin query like `findByProviderAndStoreId`). Until then an uninstalled store keeps syncing until its token calls start failing.
**Gate:** the Zid app exists in the Partner Dashboard, so the endpoint and header format can be set and one real uninstall payload captured.

### Zid first live test
None of the 2026-10-03 changes has been called against Zid. On the first run, check:
- the token response key for the partner token (`authorization` vs `Authorization`) and the profile's `user.store.id`;
- product calls accept `Authorization` alongside `Access-Token`/`Store-Id`/`Role`, and `page_size=50`;
- `search_term=<phone digits>` returns that customer's orders; View Order's not-found status; `created_at` is UTC;
- `DELETE /v1/managers/webhooks?original_id=<app id>` then the five `POST`s succeed, and deliveries arrive with `Authorization: Basic …`;
- the delivery envelope: where the event name and resource id are, and whether `updated_at` is present (event ids and normalization depend on it);
- whether a 429 carries `Retry-After`.
Migration `0066_store-authorization-token.sql` is applied to Supabase `wrluzyijfnxwrcrtvzrd` (2026-10-03); apply it to any other database first.
**Gate:** a Zid app with `ZID_CLIENT_ID`/`ZID_CLIENT_SECRET`/`ZID_APP_ID` and a dev store (none yet: ZID.md "Our Zid app").
