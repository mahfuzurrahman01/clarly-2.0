# Clarly v1 — Production-Readiness Audit

The same review [AUTOLOGIC_AUDIT.md](./AUTOLOGIC_AUDIT.md) applies to Autologic, here applied to
the engine v2 is built on. Clarly v1's engineering is strong. Its gaps are proof and a handful
of operational holes, not architecture.

Baseline when v2 was seeded (2026-10-06, commit `637e51e` + vendored SheetJS):
`apps/api` and `apps/web` type-check clean; **323 Jest suites, 4,049 tests passing, 1 skipped**.

## Strengths kept as-is

Forced RLS with fail-closed tenant transactions · queue-based respond path with burst
coalescing and stable job ids · ports and adapters for every vendor, circuit breaker on the LLM
· tickets, confidence hand-off and deterministic safety escalation · signed OAuth state ·
zod-validated DTOs with Swagger · a module-graph test that catches unregistered modules ·
eval harness with per-goal bars · HANDOFF log for every backend contract.

## Findings

| # | Sev | Finding | Evidence | v2 handling |
|---|---|---|---|---|
| 1 | P0 | **Never proven on live traffic.** No message has gone customer → Meta → Clarly → customer | `docs/PRODUCT_OVERVIEW.md` §2 | Phase A step 10 + pilots in SCALING_1K.md; not something code alone can fix |
| 2 | P0 | Several quality bars fail: false escalation 6% (bar ≤5%), wrong orders 6/285 (bar 0), tracking resolution 72.7%, agent p95 > 5 s | `docs/PRODUCT_GOALS.md`, overview §8.3 | Eval re-run on the merged build before pilots |
| 3 | P1 | **AI cost is recorded as $0 for the provider actually in use.** The price table only knows two Gemini models; production runs DeepSeek / Qwen | `telemetry/llm-cost.ts` (`PRICING` map; comment admits every cost since the swap is 0) | v2 S1: operator-editable `model_prices` table with the code table as fallback; unpriced models alert |
| 4 | P1 | No global API rate limiting and no security headers | `main.ts` has CORS only; no Throttler / helmet; only the webhook limiter exists | v2: Redis-backed limiter for public routes (widget first); helmet |
| 5 | P1 | Store OAuth state is replayable within its TTL (no single-use nonce) | `TODOS.md` "Store OAuth state is replayable" | Open; fix before store connects are opened publicly |
| 6 | P1 | Dev webhook simulator is not tenant-scoped | `TODOS.md` "P5 dev webhook simulator" | Must stay disabled in production (`DEV_SIMULATOR_ENABLED`) |
| 7 | P1 | Console-uploaded product photos can't be sent on WhatsApp (no signed URLs) | overview §12 | Signed URLs in the storage port (scheduled with S7) |
| 8 | P1 | Boot requires **both** `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` whichever providers are selected | `core/config/env.schema.ts` | v2 S6 makes keys required only for the providers selected |
| 9 | P2 | Plan docs referenced by `CLAUDE.md` were deleted (`GULF_PARITY_PLAN.md`, `AGENT_LIVE_TEST_PLAN.md`) | commit `834c0b6` | `CLAUDE.md` now points at `docs/v2/`; old plans recoverable from git |
| 10 | P2 | Install depended on `cdn.sheetjs.com` | `apps/api/package.json` | Vendored tarball (done in S0) |
| 11 | P2 | No staging deploy; CI deploy job is a stub | `docs/HANDOFF.md` (F0 notes) | SCALING_1K.md Phase A step 1 |
| 12 | P2 | No operator console: tenant comping, plans and checks are scripts | `apps/api/scripts/comp-tenant.ts` | v2 S5 `/platform` |
| 13 | **P0** | **Background sweeps and provider webhooks were blind under FORCE RLS.** Eight `runAdminQuery` reads hit FORCE-RLS tables with no `app.tenant_id`; as the production role (NOBYPASSRLS) they return 0 rows, silently. Courier polling and courier pushes, store webhooks (401 for every provider) and store sync, order approval expiry, and expired data-export purging all did nothing | Reproduced on Postgres 16 as `app_user`; unit specs mocked the DB, the one integration spec asserted `expect.any(Array)` | **Fixed in v2** (BUILD_LOG "RLS fix"): sweeps enumerate tenants then work inside `withTenantTx`; webhooks resolve the tenant through non-RLS `courier_routes` / `store_routes`; `rls-background-paths.integration-spec.ts` asserts on seeded data as `app_user` |
