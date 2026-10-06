# Autologic — Production-Readiness Audit

Read-only review of `autologic-chatbot` (1,390 commits, ~52k lines of JavaScript) done for the
v2 merge on 2026-10-06. It credits what the previous engineer got right and lists what would
break at 1,000 subscribers. Each finding names the evidence so it can be checked.

## What is genuinely good (and was kept in v2)

- **Product depth.** Bookings with Meet links, the website widget, 24 h broadcasts, follow-ups,
  the confirm-before-apply catalog assistant, photo drafts, duplicate sweep, BYOK with hard cost
  separation, priced usage metering, an operator console. These are real features that real
  tenants use, and all of them are ported.
- **Hard-won rules.** Embedding provenance per row (different 768-d spaces must never be
  compared), "a BYOK tenant is never silently routed to the platform key", "fallback text is
  customer-facing text", the Meta echo / instant-reply rules, the 24 h window checks before a
  WhatsApp send. v2 keeps every one of them.
- **Honest documentation.** `lessons.md`, `docs/error-handling.md` and the bug audits record
  causes, not just fixes.
- **Signed OAuth state** on every connect flow (Phase 12 hardening).

## Findings

Severity: **P0** breaks or leaks at scale, fix before production traffic · **P1** fix before
paid launch · **P2** improve.

| # | Sev | Finding | Evidence | Impact | v2 handling |
|---|---|---|---|---|---|
| 1 | P0 | AI reply is generated inside the Meta webhook request | `api/messenger/route.js` awaits `handleIncoming()` → `processConversation()` → Gemini before responding; `maxDuration = 60` | Meta expects a fast 200 and retries slow deliveries → duplicate replies, timeouts, lost messages under load | Webhook only enqueues; workers reply (Clarly respond-path) |
| 2 | P0 | Only the first event of each webhook delivery is read | `messenger.js:89` `body?.entry?.[0]?.messaging?.[0]`; same at :153, :174, :310, :364 | Meta batches events; every event after the first is silently dropped as traffic grows | Clarly ingest iterates all entries/changes |
| 3 | P0 | Debounce with `setTimeout` inside a serverless function | `bot.js:1323`, `:1338` | Waiting time is billed, can exceed the function limit, and two instances can both answer | BullMQ job coalescing with stable job ids |
| 4 | P0 | Tenant isolation relies on every query remembering `.eq('client_id')` | `docs/database.md` §RLS: the app uses the service-role key, which bypasses RLS | One missed filter in ~46 routes = cross-tenant leak | `FORCE ROW LEVEL SECURITY` + `withTenantTx()` |
| 5 | P0 | Webhook signature check is skipped when the app secret is missing | `api/messenger/route.js` `verifyFBSignature`: "no app secret set — skipping signature check" → `return true` | A misconfigured deploy accepts forged webhooks | Missing secret = refuse (fail closed) |
| 6 | P1 | Rate limiting is in-memory per warm instance | `lib/rate-limit.js` header comment | No real limit across instances; expensive AI endpoints can be abused | Redis-backed limiter |
| 7 | P1 | Raw webhook bodies (customer messages, names, phone numbers) logged | `api/messenger/route.js`: `console.log("[webhook] … raw=", JSON.stringify(body).slice(0, 800))` | Personal data in log storage: a PDPL / GDPR problem | Structured logs, PII-free by default |
| 8 | P1 | BYOK encryption key falls back to the Supabase service-role key | `lib/crypt.js:16` uses `AI_KEY_SECRET` **or** the service-role key | Key reuse: one leaked secret exposes both the database and every customer's AI key | Dedicated `AI_KEY_ENCRYPTION_KEY`, required at boot |
| 9 | P1 | No migration history | Schema changed by hand in the Supabase SQL editor (`docs/database.md` §Migration notes) | Environments drift; no reproducible staging; no rollback | Drizzle migrations + journal |
| 10 | P1 | No staging environment; `main` deploys straight to production | `docs/architecture.md` §7 | Every change is tested on paying customers | Staging project + preview deploys |
| 11 | P1 | Supabase row cap bugs | Recent commits: "a big `.limit()` is still capped at 1,000 rows", admin counts wrong | Silent wrong numbers in the operator console and inventory | SQL aggregates + keyset pagination |
| 12 | P1 | Firebase config committed in a public repo | `mobile/google-services.json`, `mobile-admin/google-services.json` | Firebase client keys are not secret, but they must be API-restricted in Google Cloud | Restrict the keys; v2 keeps config out of git |
| 13 | P2 | No types, 116 plain-node test scripts, no coverage gate | `package.json`, `tests/` | Refactors are risky; regressions are found by tenants | TypeScript strict + Jest + coverage gate |
| 14 | P2 | Very large single files | `bot.js` 2,036 lines, `admin/Packages.js` 2,055, `dashboard-client.js` 1,305 | Hard to review; any change risks unrelated behaviour | Modules with single responsibility |
| 15 | P2 | 39 `dangerouslySetInnerHTML` uses | `grep -rn dangerouslySetInnerHTML src` | XSS risk wherever content is tenant- or AI-generated | Not carried over; v2 renders text |
| 16 | P2 | Orders and bookings are JSON objects the model writes inside its reply text | `bot.js:598-610`, `maybeCreateBooking` | Parsing failures, duplicate bookings, prompt-injectable side effects | Validated tool calls with zod schemas and idempotency keys |
| 17 | P2 | Booking time zone hard-coded to `Asia/Dhaka` | `bot.js:916` | Wrong appointment times for any non-Bangladesh tenant | Per-tenant IANA time zone |

## Verdict

Autologic is a strong **product** with an under-built **engine**. Its feature set and its
lessons are worth keeping in full. Its runtime (webhook-synchronous AI, service-role data access,
no migrations, per-instance limits) would not survive 1,000 tenants without the failures above.
That is why v2 ports the features onto Clarly's engine instead of the other way round.
