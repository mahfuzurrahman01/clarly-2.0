# Seeded demo tenant — login credentials

Test-only credentials for the seeded tenant in Supabase project `wrluzyijfnxwrcrtvzrd`. Deliberately committed:
the tenant and both accounts exist only to be logged into by anyone working on this repo. Nothing here is a
production secret, and the password is not used outside local/staging testing.

Seed of record: `apps/api/scripts/seed-professional-tenant.ts` (`pnpm --filter api db:seed:professional`), plus
the direct SQL follow-ups listed in `docs/HANDOFF.md` → *"[Seed — demo tenant \"Zenith Coffee Roasters\" with
login credentials] (2026-10-04)"*.

## Log in

| Email | Password | `app_metadata.app_role` | Supabase user id |
| --- | --- | --- | --- |
| `admin@zenith.test` | `Zenith#Test2026!` | `admin` | `960a8312-d872-41bd-9883-bbccc1c9ba40` |
| `agent@zenith.test` | `Zenith#Test2026!` | `agent` | `5877705a-be55-426d-8c22-2cf106dbd015` |

Tenant id `e90687c9-eea3-4ffd-aefb-55ce8df86e7a` — **Zenith Coffee Roasters** (Riyadh, SAR).

Auth → tenant resolution is JWT-claims-only: `sub`, `role=authenticated`, `app_metadata.tenant_id`,
`app_metadata.app_role` (`admin|agent`), `exp` — see `apps/api/src/modules/auth/jwt-claims.ts`. There is no
`tenant_members` row to create or maintain.

Password grant (obtain the bearer token the API expects):

```bash
set -a; . apps/web/.env.local; set +a
curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@zenith.test","password":"Zenith#Test2026!"}' | jq -r .access_token
```

## What is seeded

Counts are for tenant `e90687c9-eea3-4ffd-aefb-55ce8df86e7a` only.

| Surface | Data |
| --- | --- |
| Catalog | 14 products |
| CRM | 8 customers (tags: repeat-customer, vip, subscriber, wholesale-lead) |
| Inbox | 5 conversations, 20 messages, 5 conversation outcomes (2 escalated) |
| Orders | 7 orders across `pending_approval` / `confirmed` / `fulfilled` / `cancelled`, 9 order items, order settings `human_approve` |
| Tickets | 3 (`OPEN`, `CLAIMED`, `RESOLVED`) |
| Knowledge base | 4 documents |
| Agent | `Zenith Support Agent` `2273ce2b-e4c7-485d-b567-f242e4c3ab96`, published, version 1, wired to WhatsApp number `831546da-7bf5-4fe7-986d-5ba860c2cb3e` |
| Templates | 3 WhatsApp templates, all `approved` (`order_shipped`, `subscription_renewal_reminder`, wholesale) |
| Segments | 3 — Loyal Customers (preview 2), Repeat Buyers (2), Recently Engaged (5) |
| Campaigns | 3 — completed / scheduled / draft, 16 campaign recipients |
| Shipping | 2 courier connections (aramex, smsa) with encrypted credentials, 3 shipments, 13 status events (2 delivered, 1 in transit) |
| Store / social | 1 Salla connection, 1 Messenger channel — encrypted fixture credentials |
| Webhooks | 1 outbound tenant webhook |
| Settings | delivery notifications enabled for all 8 shipment statuses; 3 tenant tools, 1 policy |
| Notifications | 7 (ticket stuck, pending approval, paused campaign, failing courier, store push failure, template gap, trial ending) |
| Exports / audit | 4 data exports (pending/running/ready/failed), 13 audit log rows |
| Billing | both `Tiny` rows at `monthly_message_limit = 10000`; active `tenant_subscriptions` row `19078fa0-a9e6-4518-a199-a204b398a2b3` so `EntitlementGuard` passes |

## Verified over HTTP

Against a local API (`pnpm --filter api dev`, `http://localhost:4000`) with an admin bearer token: health,
notifications, all four `/metrics/*` (with `?from=&to=`), agents (+ sandbox), segments (+ preview), campaigns
(+ stats, recipients), data exports, conversations (+ messages), orders (+ shipments, settings), catalog,
templates, tickets, knowledge base, audit log, outbound webhooks, store/courier/social connections, delivery
notification settings, billing subscription/usage/plans, WhatsApp number lists, tenant onboarding.

The agent account gets the same reads on inbox/tickets/campaigns and **403** on admin-only routes
(`/audit-log`, `/billing/*`) — expected, not a bug.

## Not simulated

- Real inbound WhatsApp: conversations are seeded rows, so the webhook → agent → reply loop still needs a
  genuine inbound post to `POST /webhooks/whatsapp`.
- Outbound Salla / Aramex / SMSA / Meta calls fail authentication by design — the stored credentials are
  fixtures.
- `GET /metrics/escalation-breakdown` returns `{}` and `/metrics/knowledge-gaps` returns empty arrays for this
  data; both are real responses, not stubs.
