# Clarly 2.0 — Handover (2026-10-06)

For the next engineer (and their Claude). Read this first, then `docs/v2/README.md`.
Repo: `clarly2.0`, branch **`v2/merge`** (HEAD has this file). Everything below is committed.

## 1. What this project is

Clarly 2.0 merges two products into one SaaS:
- **Autologic** (`autologic-chatbot`, live as TellMore AI): rich feature set (bookings + Google Calendar,
  website widget, 24h broadcasts, follow-ups, AI catalog assistant, BYOK, usage metering, operator
  console) on a weak engine (Next 14 JS on Vercel, AI reply inside the webhook, service-role DB access).
- **Clarly v1** (`Clarly`): strong engine (NestJS + workers + BullMQ, FORCE RLS, Drizzle migrations,
  TypeScript, 4k tests, evals) and the UI the owner wants (paper/ink/lime, AR RTL), fewer features.

**Decision (binding, ARCHITECTURE.md §1):** Clarly v1 is the **engine and UI**; every Autologic feature is
**re-implemented as Clarly modules**. Nothing of Autologic's code or styling is copied. The owner said
"take Autologic as the base"; this was interpreted as *feature* base and flagged to him for
confirmation (he did not object before handing off — confirm with him once).

## 2. Where things stand

| Stage | Scope | State |
|---|---|---|
| S0 | Seed from Clarly v1, docs (architecture, feature matrix, conflicts, audits, 1k plan) | ✅ committed |
| S1 | Tenant profile (vertical/country/currency/locale), `platform_admins`, `/platform` API base, `platform:grant` | ✅ |
| S2 | Bookings: services, hours, Google Calendar (port+adapter), agent tools `check_availability`/`book_appointment`, console | ✅ |
| S3 | Website chat widget = new `web` channel through the same ingest/respond path, signed visitor tokens, `widget.js` | ✅ |
| RLS fix | **P0 v1 bug**: 8 sweeps/webhooks read FORCE-RLS tables with no tenant → silently empty in prod. Fixed (tenant-by-tenant sweeps, `courier_routes`/`store_routes`) | ✅ |
| **S4** | Broadcasts (24h window), follow-ups, per-channel bot pause, customer tags | 🟡 **schema only** (migration 0074 + `messaging.table.ts`) |
| S5 | Operator console UI, `usage_events` + `model_prices`, plan limits, near-limit banners | ⬜ |
| S6 | BYOK (`ai-keys`), OpenAI + OpenRouter adapters, platform provider switch, keys required only for selected providers | ⬜ |
| S7 | Catalog assistant (propose→confirm→apply), photo drafts, duplicates, URL import, catalogue health | ⬜ |
| S8 | Web push (VAPID) + FCM, notification kinds, global search, PWA | ⬜ |
| S9 | Manual payment provider, help center, Bangla console locale, mobile shell | ⬜ |

Per-stage detail and verification: `BUILD_LOG.md`. Backend contracts: `docs/HANDOFF.md` (append one entry per task — mandatory, see `CLAUDE.md`).

Last verified (cloud copy, before the S4 schema): API + web type-check clean; **336 unit suites / 4,221 tests pass**;
integration suites for widget (9), bookings (17), platform (6), RLS paths (6), tenant isolation all pass.

## 3. Next: finish S4 (design already decided)

Autologic sources to read: `src/lib/broadcast.js`, `broadcast-send.js`, `followup.js`, `followup-cron.js`, `tags.js`.
Do **not** port its weaknesses: browser-driven batch sending, in-memory throttles, `Asia/Dhaka` time, "one tag per conversation".

1. **`ChannelPauseService`** in its own tiny module (imports only `TenantContextModule`, so `WebhookModule` can import it
   without cycles). Table `channel_pauses` (row = paused). API: `GET /channel-pauses`, `PUT|DELETE /channel-pauses/:channel/:accountId` (admin, audited).
   In `webhook/respond-path.processor.ts`, right after the `isHandedToHuman` block: if the conversation's
   `(channel, channelAccountId)` is paused → `recordInboundMessages` and return (no reply, no ticket).
2. **`ProactiveSenderService`** (new `messaging` module) — the one place broadcasts and follow-ups send through:
   `send({ tenantId, conversationId, text, clientMessageId, authorUserId | null })` → `sent | failed | skipped(reason)`.
   Order: `getConversation` → idempotency `findByClientMessageId` → skip `web` channel → window via
   `ChannelPolicyRegistry.for(channel).evaluate({ lastInboundAt, now, humanAgent: false })` **and** require
   `expiresAt - now ≥ 15 min` → consent `CustomerConsentService.get(tenant, phone, channel)` skip if `optedOutAt` or
   `marketingOptedOutAt` → skip `handoverState === 'human'` → skip paused channel → account = `conversation.channelAccountId`
   (no fallback; skip if null) → record (`recordHumanAgentMessage` with author for broadcasts, **no handover**;
   `recordSystemTemplateMessage` for follow-ups) → `ChannelRegistry.for(channel).sendText` → `attachOutboundDelivery` /
   `markOutboundFailed` (store the platform's own error text). Do **not** use `HumanReplyService` (it starts a handover and skips consent).
3. **Broadcasts** (`broadcasts`, `broadcast_recipients`): `POST /broadcasts/preview` → counts `{ eligible, needsTemplate (outside window),
   optedOut, withHuman, channelPaused }`; audience = `conversations` ⋈ `customers` on `(tenant_id, channel, customer_phone=phone)`,
   channels ∈ {whatsapp, messenger, instagram}, optional segment filter via `compileSegmentCondition` (it is over `customers`),
   cap 10,000. `POST /broadcasts` (admin + `EntitlementGuard`, audited) snapshots eligible recipients in one tx
   (partial unique index allows one `sending` per tenant → 409) and enqueues `broadcast-send` batch jobs
   (copy the campaign pattern: `campaign-send.queue.ts` / processor / stable job ids, batch 25, claim
   `pending→sending` with `UPDATE … RETURNING`, reclaim rows stuck in `sending` > 5 min). The window is **re-checked at send time**.
   `GET /broadcasts`, `GET /broadcasts/:id` (+ recipient errors), `POST /broadcasts/:id/cancel`. Finalise counts when nothing is pending.
4. **Follow-ups** (`followup_settings`, `followups`): settings API (admin). Repeatable sweep every 15 min registered with
   `registerJobSchedulerInBackground` (see `courier/shipment-poll-scheduler.service.ts`), per tenant via
   `TenantDirectoryService` + `sweepTenantsWithBoundedConcurrency` (**never** `runAdminQuery` on RLS tables — that was the P0 bug).
   Candidates: `last_inbound_at` between `now-23.5h` and `now-delay_hours`; last message in the conversation is from the business;
   not handed to a human; no follow-up for that conversation in 30 days; no order/booking since the anchor;
   audience `interested` = customer label `hot`/`warm`. Insert the `followups` row **before** sending
   (unique `(tenant, conversation, anchor)` = no double send), ≤ 50 per tenant per run. Default message from tenant `default_locale` (EN/AR).
5. **Tags**: `customers.tags` (jsonb) and the segment `tag{hasAny}` leaf already exist. Add `PATCH /customers/:id` (`tags` ≤ 20, each ≤ 32 chars, trimmed, de-duplicated) via `CustomerService.updateCustomer`.
6. **Console** (EN + AR, Clarly design system): `/broadcasts` (compose → live preview counts → send → progress/history with
   per-recipient errors), `/settings/follow-ups`, pause toggle per channel on `/settings/channels`, tag editor in the inbox customer panel.
7. **Housekeeping**: new audit keys (3 edits: catalogue, golden spec, console copy), notification kind `broadcast_finished` (optional);
   **remove the 5 TEMPORARY entries in `data-export-assembler.service.spec.ts` and export these tables**; HANDOFF + BUILD_LOG entries;
   unit specs + one integration spec on real Postgres as `app_user` (window closed at send time → skipped; opted-out never sent;
   double enqueue → one message; follow-up sweep sends once per anchor).

## 4. How to work in this repo

- Local services: `docker compose up -d` (Postgres 16 + pgvector with `app_user` NOBYPASSRLS, Redis 7). `apps/api/.env` from `.env.example`.
- `pnpm install` (SheetJS is vendored in `vendor/`, no CDN needed) → `pnpm --filter api run db:migrate`.
- Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`; same in `apps/web` (`npx tsc --noEmit`).
- Unit: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest` (~3.5 min).
- Integration: `NODE_OPTIONS=--experimental-vm-modules npx jest --config ./test/integration/jest-integration.json <name> --forceExit`.
  `--forceExit` is needed: suites that boot `WebhookModule` leave one Redis socket open (pre-existing v1 issue, not yet found).
  Known pre-existing failures on a laptop: Stripe suites need `stripe-mock`; respond-path suites need a live LLM;
  `orders` / `campaign-segment-plan` seed RLS tables via `runAdminQuery` (test bug, same root cause as the RLS fix).
- Lint changed files: `npx eslint --fix <files>` (3 pre-existing v1 lint errors in untouched spec files).
- Conventions that are enforced: module registered in `modules/index.ts` + `AppModule` (module-graph spec);
  every new tenant table FORCE RLS + export coverage (completeness spec); audit keys need catalogue + golden + console copy;
  zod DTOs; one HANDOFF entry per backend task; commit footer per `CLAUDE.md` if your team uses one.
- **RLS rule of thumb:** background job or webhook with no tenant → list tenants (`TenantDirectoryService`) or use a
  non-RLS routing table, then `withTenantTx(tenantId)`. `runAdminQuery` on an RLS table returns **nothing**.

## 5. Open decisions for the owner (CONFLICTS.md C21–C25)
1. Brand/domain (Clarly vs TellMore AI); 2. migrate Autologic's live tenants or not, and when;
3. final plan prices per currency (SAR first); 4. one Meta app (Clarly's); 5. Google OAuth project (reuse Autologic's verified one or new).
Plus: confirm the "Clarly engine + Autologic features" interpretation (§1).

## 6. Manual steps
`docs/v2/MANUAL_STEPS.md` — env vars, one-off commands, external accounts, quality gates.

## 7. Notes
- `clarly2.0/.v2-transfer/` on the owner's Mac holds sync bundles from the cloud session; ignored by git (`.git/info/exclude`), safe to delete.
- Autologic's repo is **public** and has Firebase configs committed (AUTOLOGIC_AUDIT #12) — restrict those keys in Google Cloud.
- The v1 `Clarly` folder is untouched; `clarly2.0` has the full v1 history plus the v2 commits.
