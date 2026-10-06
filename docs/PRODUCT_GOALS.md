# What We Want Clarly to Achieve

Clarly is a multi-tenant AI customer-service and commerce agent for Gulf merchants on WhatsApp,
Messenger and Instagram. **The aim:** a merchant connects their channels and catalog, and the
agent runs customer conversations end to end — answers questions, sells, takes orders, tracks
deliveries, handles complaints — with a human stepping in only when it matters.




Endpoint and contract detail: [HANDOFF.md](./HANDOFF.md).

Legend: ✅ achieved · 🟡 built, not yet proven · 🔴 built, failing its bar · ⬜ not started

## Goals

### 1. Answer customers correctly from the merchant's own knowledge 🔴

Customers get accurate answers about products, policies, hours and delivery — never invented
facts. When the agent isn't sure, it hands off instead of guessing.

- **Done when (L1):** resolution ≥85%, false escalation ≤5%, missed escalation 0,
  hallucination 0, injection leak 0, recall@5 ≥90% (median of 5 runs).
- **Where we are:** knowledge base, retrieval, confidence scoring and handoff are built. Cycle 3
  (2026-09-30, prompt v12) failed: resolution 94.0% ✅, recall@5 98.5% ✅, hallucination 0 ✅, leaks
  0 ✅, false escalation 6.0%, missed escalation 2. The cycle 3b partial re-run (2026-09-30, prompt
  v13 plus fixes; 19 of 23 corpora x 5 runs, **not** clinic-appointments, opening-hours, multi-turn
  or out-of-scope) cannot move this goal: a partial re-run does not evaluate the full-corpus gate,
  and it still shows failures. Better: catering-quotes missed escalation 0 (peanut allergy and
  photography now stable-pass), catering-policies 99/100, arabizi 100/100, tone-escalation 50/50,
  refund-policy 40/40 (the last two partly from loosened corpus expectations that still need owner
  sign-off). Worse: conflicting-docs#3 misses an escalation in 5/5 runs, catering-policies#13 in 1/5,
  and grounding/confidence-0 false escalations persist (khaleeji 20% median false escalation,
  egyptian#1, multi-doc EMI) and grew on ambiguous price questions. voice-support was INVALID in 3b; it passes 9/9 on the
  Audar ASR binding (2026-10-01, targeted run, not a gate run).
  **To mark this met:** a full 23-corpus x 5-run re-run on a fixed build with resolution ≥85%,
  false escalation ≤5%, missed escalation 0, hallucination 0, leaks 0, recall@5 ≥90% (median of 5),
  including a valid voice-support corpus.

### 2. Sell: find the right product, quote the right price, take the right order 🔴

A customer can describe or photograph a product, get the real price and stock, and place an
order the merchant can fulfil without fixing it by hand.

- **Done when (L2):** tool selection ≥95%, argument accuracy ≥95%, wrong orders 0, price
  hallucination 0; the agent asks for missing details instead of inventing them.
- **Where we are:** catalog (F20: CRUD, CSV import, image upload, fuzzy search) and chat order
  capture (F25) are built. Cycle 3b (2026-09-30, prompt v13, 7 commerce corpora x 3 runs) is the
  best run so far but still fails: tool selection 97.3% pooled ✅ (journey alone 90.5%), argument
  accuracy 100% ✅ (126/126), price hallucination 0 ✅, orders written without telling the customer
  0 ✅ (was 4), wrong orders 6 of 285 (was 21; journey 3, order 3), forbidden order writes 3 (was
  19), roundtrip-cap 15/15. Open: the out-of-stock colour variant is ordered as the plain model
  (red X200, 3/3), journey has a fabricated-citation hallucination and an empty-`create_order`
  stable-fail, and `track_order`/`create_order` calls are sometimes skipped or empty. Per-run
  values were not recomputed, and tool selection and arguments must hold in every run.

### 3. Tell customers where their order is 🔴

"Where is my order?" gets a real answer from the courier, and customers get proactive updates —
never a guessed date, and never someone else's order.

- **Done when:** L2 `commerce-tracking` passes; L3 script 6 works on all channels; cross-customer
  leak 0; courier outage produces "couldn't check right now" (L5).
- **Where we are:** Aramex, SMSA, Naqel and J&T tracking with ETAs (F26) is built, plus
  `/deliveries` and an "Add tracking number" form. Cross-customer leak is 0 ✅. Contract
  tests only — no courier sandbox yet, and real ETA field names are unconfirmed. `commerce-tracking`
  fails its bar in two consecutive cycles (2026-09-30 cycle 3 and 3b): tool selection and arguments
  100%, but resolution 72.7% (3b worst run 63.6%) and false escalation 27.3%. The grounding fix did
  not clear AWB-100-2003 (3/3 still `grounding_not_covered`); the exception-shipment fixture now
  seeds correctly, but its two "late order" cases now escalate as complaints against an
  expect=resolve corpus (an owner decision); one run missed an escalation (AWB-100-3002).
  Status moved to 🔴 because the L2 bar fails on real calls.

### 4. Catch complaints and never lose an unhappy customer 🔴

Complaints, distress and angry customers are recognised, labelled and routed to a human with a
ticket — matched tone, no arguing.

- **Done when:** L2 `commerce-complaint` passes; L3 scripts 7–9 (complaint → ticket, escalation,
  human takeover and hand-back) pass on every channel; missed escalation 0.
- **Where we are:** complaint detection, ticket queue and kanban (`/tickets`), unified inbox with
  human takeover (`/inbox`) are built and QA'd in the console. The end-to-end flow on a real
  channel hasn't run. Cycle 3b (2026-09-30): `commerce-complaint` 42/45 (was 39/45) with the
  late-delivery-after-`track_order` missed escalation cleared (deterministic gate) and safety
  escalation (allergy, health, incident) now deterministic, catering-quotes missed escalation 0.
  Still failing the bar: complaint#8 (calm late-delivery question) ends in `LLM_ERROR` from an
  empty `track_order` call (0/3), L1 missed escalations are not 0 (conflicting-docs#3 5/5,
  catering-policies#13 1/5), and L3 scripts 7-9 have not run. Status moved to 🔴 because the L2
  bar fails on real calls; the corpus expectations for the damaged-item cases were loosened and
  need owner sign-off.

### 5. Work on the channels Gulf customers already use 🟡

WhatsApp, Messenger, Instagram DMs and FB/IG post comments — connected by the merchant in a few
clicks and kept healthy.

- **Done when (L3/L4):** all 14 scripted conversations produce the correct outcome on WhatsApp,
  Messenger and Instagram, in Arabic and English, with no duplicate or missing replies; comment
  auto-reply picks the right action (reply / DM / hide).
- **Where we are:** WhatsApp Embedded Signup with health checks and reconnect (F21),
  Messenger/Instagram via Facebook Login (F22) and comment auto-reply (F23) are built. Tested
  against recorded Graph fixtures and mocked E2E only — no real message has gone webhook →
  agent → phone. Comment-intent accuracy is 79.3% (purchase class 60%).

### 6. Understand how Gulf customers actually talk 🔴

Khaleeji, Egyptian, Levantine, Arabizi and English, mixed mid-sentence; voice notes; product
photos.

- **Done when:** dialect corpora pass the L1 bars; voice notes transcribe and get answered
  (L3 script 3); photo → product → price works (L3 script 2); native-speaker red team (L7) finds
  no critical issues.
- **Where we are:** dialect handling and a CI dialect eval (F27), image understanding and voice
  playback in the inbox are built. Voice transcription now works in the eval
  (2026-10-01): `ASR_PROVIDER=openai-compatible` against the self-hosted Audar-ASR endpoint passes
  voice-support 9/9 over 3 runs (was 15/15 `transcription_failed` on Hugging Face, 402 credits
  depleted; Gemini 2/3 with 503s). Open: on a silent clip the ASR hallucinates a phrase, so
  media-unreadable#2 escalates for the wrong reason (still reaches a human); only MSA clips tested.
  Dialect text corpora, cycle 3b (2026-09-30): Levantine 99/100, Khaleeji 91/100 (was 95: "بكم هذا؟"
  and "شنو المواد اللي منه؟" regressed, charger fixed), Egyptian 95/100 (the iPhone case is fixed,
  "كام سعره؟" is a new stable-fail: prompt v13 asks which product and escalates), Arabizi 100/100
  (was 90), language-mix 55/55, all with 0 hallucination. Arabic product lookup now finds
  kitchen-category and article-prefixed queries. Photo → price: vision-product 24/25 (one flaky
  ambiguous price turn); the Arabizi + image answer no longer drifts into Bengali. Dialect
  voice accuracy needs pilot samples.

### 7. Keep the merchant's store and catalog in sync on their own 🟡

Products, prices and stock from Shopify, WooCommerce, Salla or Zid show up in the agent's answers
without manual work, and order status reads back.

- **Done when (L4):** synced products are answerable within one sync cycle; a price change in the
  store shows in the agent's next answer.
- **Where we are:** all four connectors, order read-back and BullMQ sync jobs (F24) are built.
  Contract tests only — no merchant sandbox credentials yet. Zid adapter aligned to docs
  (2026-10-03, docs/integrations/ZID.md), live-unverified; Zid order creation is refused until the
  order carries a shipping method, structured address and email (TODOS.md).

### 8. Bring customers back with campaigns 🟡

Merchants broadcast approved WhatsApp templates to the right segment, within budget, and the
agent picks up replies in context — including taking the order.

- **Done when (L4):** a campaign reply ("yes I want it") continues in context and produces a
  correct order.
- **Where we are:** segments, template checks, spend cap and throttled sender (F19) are built and
  integration-tested on real Postgres + Redis + BullMQ. Never sent live.

### 9. Be fast and stay up under real load 🔴

Customers get a reply in seconds, at peak traffic, even when a provider fails.

- **Done when:** agent text p95 <5s, retrieval p95 <400ms (L6.1); end-to-end reply p95 <10s at
  100 concurrent conversations, error rate <1% (L6); no silent drops, duplicate sends or invented
  facts under any failure (L5).
- **Where we are:** failing. Cycle 3b (2026-09-30, rerank on) is worse on the bars: a Cohere
  rerank stall of about 10.5 s (likely a timeout) hits 1-3 turns per run in nearly every corpus, so
  retrieval p95 is 11-13 s in the worst runs (median 1.0-1.3 s without stalls, so 400 ms is
  unreachable as built: remote embed ~400 ms, vector store ~750 ms, rerank 330-430 ms). Agent
  text p95: 11 of the 16 re-run L1 text corpora exceed 5 s in their worst run (8 of 20 in cycle 3), and commerce (tool) turns run
  11-13.5 s p95 (three sequential model rounds). Fixed: the loop deadline is now net of retrieval
  and a deterministic order confirmation replaces the dropped one (orders written but not announced
  4 → 0). Vision turns still need deadline headroom. Embedding and Cohere stalls of 7-38 s still
  occur. No load harness; rate limiting covers webhooks and comments only.

### 10. Be safe to trust with customers' data 🟡

No prompt-injection leaks, no cross-customer data, no giveaway prices, and compliance with Meta
and Gulf privacy rules.

- **Done when:** injection leak 0, cross-customer leak 0, all adversarial cases pass (L1/L2); red
  team (L7) leaves nothing open in hallucination, leak, wrong-order or cross-customer categories.
- **Where we are:** guardrails, data export, retention, audit log, Meta data-deletion and
  deauthorize callbacks and tenant offboarding are built. Cycle 3b (2026-09-30): injection leak 0
  ✅ (all re-run L1 and L2 corpora), cross-customer leak 0 ✅ (adversarial 0/21, tracking gate
  passes), price hallucination 0 ✅, and commerce-adversarial is now 45/45 ✅ (was 42/45; the
  "admin mode" corpus guard was narrowed to affirmative wording and the judge treats injected KB
  text as untrusted) with L1 adversarial 40/40. Safety escalation (allergy, health, incident) is
  deterministic. Open: conflicting-docs#3 answers from one of two conflicting documents (5/5), which
  is a hallucination-protection concern. The integration-test teardown that wiped the shared dev
  database is scoped and guarded. Red team not run; legal/PDPL review is founder-owned (Phase 0).

### 11. Let the merchant run it all from one console 🟡

Set up, test, watch and pay without talking to us.

- **Done when:** billing E2E (signup → trial → checkout → active → cancel → blocked) passes;
  every console page works against a clean database; pilot merchants sign off (L8).
- **Where we are:** playground, insights, settings (hours, agent config, templates, channels,
  store, delivery) and billing with dunning are built. 3,353 unit tests green; QA 2026-09-01
  scored 92. Production console QA on 2026-10-05: 85/100 (2 high, 7 medium, 11 low issues); the
  two high-severity ones (silent human-handover, template validation) and the RTL/i18n/mobile/a11y
  findings are fixed and pushed. Checks on 2026-10-05: 319 API suites (4004 tests) pass, web and
  API typecheck clean. Still open: no frontend tests for orders, campaigns, courier or store
  consoles; no billing E2E; no pilot sign-off. The earlier local 500s on `/campaigns`, `/catalog`,
  `/tickets` came from migration tracking and were not re-checked.

### 12. Reach merchants beyond the desktop ⬜

- **Mobile inbox app** (F28) so merchants can take over chats from their phone.
- **Website chat widget** (F29), only if pilot customers ask for it.

## Launch = all goals met on real traffic

Clarly is ready for full launch when goals 1–11 meet their bars **and** pilot merchants in
shadow mode (L8) show real-traffic resolution ≥85%, missed escalation 0, no wrong orders, and
sign off.

## Known gaps blocking the goals

- **Nothing tested live:** no real calls to Meta, stores or couriers yet. Live Meta checks need
  the founder-owned Phase 0 setup; stores and couriers need sandbox credentials. L3 (real channels
  in Meta Development mode) can run before Phase 0.
- **Model hosts unstable:** the self-hosted LLM and embedding hosts timed out during the
  2026-09-29 eval cycles, stalling the cycle-2 re-run and inflating latency.
- **Product photos can't be sent on WhatsApp:** console-uploaded images have no signed URLs.
- **Migration bookkeeping out of sync:** the dev database is Supabase only. Migration files go
  up to `0069` (0067 confirmed applied to production 2026-10-05), but drizzle's tracking table is incomplete, so `drizzle-kit migrate` can't be
  trusted to report state.
