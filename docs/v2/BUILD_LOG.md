# Clarly 2.0 — Build Log

One entry per stage. Each entry says what shipped, how it was verified, and what is still open.
Backend contracts for every stage are also appended to `docs/HANDOFF.md`, per `CLAUDE.md`.

## S0 — Seed and plan (2026-10-06)

- `clarly2.0` cloned from Clarly v1 (`feat/waitlist-gate-product-doc` @ `637e51e`, full history),
  working branch `v2/merge`; the v1 remote is kept as `clarly-v1`.
- SheetJS (`xlsx` 0.20.3) vendored in `vendor/` so `pnpm install` no longer reaches
  `cdn.sheetjs.com` (it is blocked on locked-down networks and CI caches).
- Architecture, feature matrix, conflicts, both audits, the 1k-subscriber plan written
  (`docs/v2/`).
- **Verified baseline:** `@repo/errors` builds; `apps/api` `tsc --noEmit` clean; `apps/web`
  `tsc --noEmit` clean; `apps/api` Jest: 323 suites, 4,049 passed, 1 skipped.

## S1 — Foundations (2026-10-06)

**Shipped**
- Tenant profile: `tenants.vertical / country / currency / default_locale` (migration 0070),
  `GET /onboarding/tenant` extended, `PATCH /onboarding/tenant/profile` (admin, audited),
  console page Settings → Workspace (EN + AR).
- Operator foundation: `platform_admins`, `PlatformModule` with `PlatformAdminGuard`,
  `GET /platform/me`, `GET /platform/tenants` (search + keyset paging), `GET /platform/tenants/:id`,
  `platform:grant` script for the first operator.
- Operator reads across tenants go **one tenant at a time through `withTenantTx()`** — no
  BYPASSRLS role, no SECURITY DEFINER aggregate (ARCHITECTURE §5).

**Verified**
- `apps/api` and `apps/web` type-check clean; ESLint clean on every changed file.
- Unit: platform guard (6), cursor/escape helpers, profile DTO, profile service; audit catalogue
  completeness spec updated. Module-graph spec passes with `PlatformModule` registered.
- Integration (real Postgres 16 + pgvector, real HTTP, real HS256 JWT):
  `platform.integration-spec.ts` 6/6, `tenant-directory.integration-spec.ts` 6/6.
- The integration test caught a real bug before it shipped: a millisecond keyset cursor
  silently ended the tenant list when two rows shared one statement's `now()`; the cursor now
  carries Postgres's microsecond text.
- `platform:grant` run end to end (grant, list, revoke) against the local database.

**Decisions taken in this stage**
- Autologic's deterministic "wants a human" lexicon is **not** wired into escalation. Clarly's
  escalation is model-decided and already fails its false-escalation bar (6% vs ≤5%); a lexicon
  that fires on "phone number" would make that worse. The EN/BN/Banglish phrases go into the
  eval corpus instead, so the model is measured on them.
- Bangla console locale deferred to S9 (GCC first); the API already accepts `bn`.

**Integration suite status on this machine** (not CI): 29 suites pass, 9 fail, 1 skipped. The 9 failing
suites fail for reasons that pre-date v2 and are unrelated to it: Stripe suites need
`stripe-mock`; respond-path suites wait on a live LLM; `orders` and `campaign-segment-plan`
seed RLS tables through `runAdminQuery` without a tenant GUC, which `FORCE RLS` rejects; one KB
upload assertion. Logged as follow-ups, not fixed in this stage.

## S2 — Bookings (2026-10-06)

**Shipped**
- `BookingModule`: settings (mode `disabled`/`request`/`auto`, IANA time zone, weekly windows,
  slot grid, notice, horizon), services, bookings with a full status lifecycle, Google Calendar
  (port + adapter, signed single-use OAuth state, encrypted refresh token, free/busy, events
  with Meet links, `sendUpdates=all`, dead-grant detection → `needs_reconnect` + notification).
- Agent tools `check_availability` and `book_appointment` (zod schemas, machine-token results,
  placeholder/provenance guards, per-turn idempotency, execution gate on mode), wired into
  `ToolExecutionService`; deterministic confirmation when a deadline is missed after booking.
- Migration 0071 (4 FORCE-RLS tables), notifications `booking_requested` /
  `calendar_needs_reconnect`, 10 audit keys (API + console EN/AR), data-export coverage.
- Console: `/bookings` agenda and `/settings/bookings`, EN + AR; nav entries.

**Verified**
- Pure scheduling engine: 35 unit tests incl. DST gaps/overlaps, zone date boundaries, buffers,
  notice, grid. Executors, service matching, Google adapter (fake transport), tool routing,
  confirmation fallback: unit-tested.
- `bookings.integration-spec.ts` 17/17 on real Postgres + Redis: role gating, per-tenant tool
  enablement, availability, agent booking + retry idempotency, **two customers racing for one
  time → exactly one booking**, buffer handling, console overlap 409, RLS isolation, cancel
  frees the slot, request mode → notification → confirm, forged OAuth callback rejected.
- Full API unit suite: 331 suites / 4,162 tests pass (+ the data-export completeness guard,
  which caught the new tables and now lists them).
- API and console type-check; ESLint clean on all new/changed files (3 pre-existing v1 lint
  errors in untouched spec files remain).

**Decisions**
- Times are never computed by the model: it passes local `date` + `time`, code resolves the zone.
- `auto` mode with a connected but unreadable calendar records a **request**, never a confirmed
  booking.
- One schedule per workspace (no overlapping appointments); multi-staff capacity deferred.
- Booking guidance lives in the tool descriptions, not L0, so `PROMPT_VERSION` is unchanged and
  no eval re-run is forced for tenants without bookings. Tenants that turn bookings on need an
  eval pass on a booking corpus before pilots (added to MANUAL_STEPS).

## S3 — Website chat widget (2026-10-06)

**Shipped**
- New channel `web`: `WidgetModule` (console `GET/PATCH /widget`, `POST /widget/rotate-key`;
  public `/widget/v1/config|session|messages`), `WebChannelAdapter` + `WebChannelPolicy`,
  tenant resolution by widget id, migration 0072 (`web_widgets`).
- Visitor messages go through `WebhookIngestService.ingestMessages()` (extracted from `ingest()`),
  so the widget gets exactly the same closure, dedup, rate-limit, consent and respond-path rules as
  WhatsApp. Replies reach the browser by polling the visitor's own conversation.
- Security beyond Autologic's widget: API-minted, HMAC-signed visitor ids (Autologic trusted a
  browser-made id, so a guessed id could read someone else's chat); exact origin allow-list per
  widget; Redis rate limits per IP and per visitor shared by every replica; Shadow-DOM embed that
  never renders message text as HTML; `trust proxy` set from `TRUST_PROXY_HOPS` so per-IP limits
  see the visitor, not the load balancer.
- CORS rule extracted to `common/cors.ts` and used by both `main.ts` and the integration spec.
- Console: Settings → Website chat (EN/AR), snippet with copy, rotate key; inbox channel badge.

**Verified**
- `widget.integration-spec.ts` 9/9 on real Postgres + Redis + HTTP: console create/enable/role
  gating, tenant separation, origin allow-list and CORS preflight, signed sessions, forged token
  refused, message ingested once onto the respond-path queue (dedup on retry), a visitor sees only
  their own conversation, disable + key rotation kill the old snippet.
- Unit: origin normalisation, visitor token, CORS options (4), channel policy, audit catalogue.
- Full API unit suite 334/334 suites, 4,175 passed. API and console type-check; ESLint clean on
  every changed file except the pre-existing v1 error in `conversation-query.service.spec.ts`.

**Found, not fixed (pre-existing v1)**
- Integration suites that boot `WebhookModule` leave one Redis socket open, so a single-file
  `jest` run never exits (`conversation-coalescing` does the same on v1). Run integration suites
  with `--forceExit` until the unclosed client is found.

## RLS fix — no-tenant paths (2026-10-06, between S3 and S4)

**Found:** while designing S4's follow-up sweep. Clarly v1 read FORCE-RLS tables from background
jobs and provider webhooks through `runAdminQuery` with no tenant set. Under the production role
(`app_user`, NOBYPASSRLS) those reads return **zero rows** with no error. Eight call sites were
affected (audit by a separate agent, each verified on seeded data):

| Path | Effect in production before the fix |
|---|---|
| Shipment poll sweep (`findDueForPoll`, `findAllActive`) | No shipment was ever polled; statuses and delivery notifications froze |
| Courier push routing (`findByRoutingKey`) | Every courier push rejected as "no active connection" |
| `track_order` refresh (`findByIdsAdmin`) | Background refresh did nothing |
| Store webhook routing (`findByProviderAndStoreId`) | Every Salla/Zid/Shopify/Woo webhook answered 401 |
| Store sync sweep (`findAllActive`) | Catalog never re-synced |
| Order expiry sweep | `pending_approval` orders never expired |
| Data-export purge | Expired export bundles never deleted (retention/privacy) |

**Fix (FORCE RLS unchanged, no BYPASSRLS role, no SECURITY DEFINER):**
- `TenantDirectoryService.listTenantIds()` (the `tenants` table is not RLS-scoped) + the existing
  `sweepTenantsWithBoundedConcurrency`: every sweep now works tenant by tenant inside `withTenantTx`.
  `SHIPMENT_POLL_BATCH_LIMIT` is now per tenant, so one merchant's backlog cannot starve others.
- Migration 0073: `courier_routes` and `store_routes`, non-RLS routing keys (no secrets) written in
  the same transaction that activates or deactivates a connection. Webhooks learn the tenant there,
  then load the connection and secret under that tenant and re-check it is active and still owns the
  key. Deactivating removes the route (fail closed).
- Refresh jobs carry `tenantId`; a legacy job without one is skipped (the sweep covers it).
- `pnpm --filter api run routes:backfill` rebuilds routes for connections older than 0073
  (idempotent, runs as the normal role).

**Verified**
- `rls-background-paths.integration-spec.ts` 6/6 as `app_user` (the spec asserts the role is
  neither superuser nor BYPASSRLS): courier and store routing find seeded connections of the right
  tenant; deactivation removes the route; the newest store connect owns the store and an older
  tenant's disconnect leaves it alone; backfill restores a missing route; the poll sweep reaches a
  seeded due shipment and calls its courier with its credentials.
- Unit: 336 suites / 4,221 tests (new: tenant directory, per-tenant sweep calls, route
  write/delete, routing edge cases). Related integration suites 77/77. API type-checks.

**Behaviour change to know:** if two workspaces connect the same store, the latest connect owns its
webhooks (as before); if that one disconnects, the store's webhooks stop until a workspace
reconnects. The old code silently fell back to the older connection.

## S4 — Broadcasts, follow-ups, channel pause, tags (in progress)

- Committed: migration 0074 (`channel_pauses`, `broadcasts`, `broadcast_recipients`, `followup_settings`,
  `followups`, all FORCE RLS) and `persistence/drizzle/messaging.table.ts`. No services or console yet.
- The five tables are TEMPORARILY excluded from the export completeness spec; S4 must export them.
- The full design for the rest of S4 is in [HANDOVER.md](./HANDOVER.md) §3.
