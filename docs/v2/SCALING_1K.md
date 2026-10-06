# Clarly 2.0 — Plan for the First 1,000 Subscribers

What it takes to run 1,000 paying workspaces reliably: the load to expect, the infrastructure
to size for it, the steps in order, and what it costs. Numbers are planning estimates; replace
them with measured values after the first pilots (the `usage_events` table records every AI
call with tokens and price, so real figures appear from day one).

## 1. Load model

| Assumption | Value | Why |
|---|---|---|
| Workspaces | 1,000 | Target |
| Conversations / workspace / month (median) | 1,000 | Starter plan cap; Growth tenants above, trials below |
| Inbound messages / conversation | 8 | Typical sales/support chat |
| Agent turns / conversation | ~5 | Bursts are coalesced into one turn |
| Peak-hour factor | 4× average | GCC evening peak, Ramadan nights higher |

Derived:

- **Turns:** 1,000 × 1,000 × 5 = **5 M turns/month** ≈ 1.9 turns/s average, **~8/s at peak**,
  bursts of ~20/s (campaign replies).
- **In-flight AI calls at peak:** 8 turns/s × ~6 s per turn (1–3 model calls + retrieval) ≈
  **50 concurrent**, bursts ~120. This is the number that sizes workers and provider rate limits.
- **Rows:** ~16 M messages/month (in + out) ≈ 200 M/year. `messages` needs time partitioning
  or a retention policy before month 6.
- **Vectors:** KB ≈ 1,000 × 50 docs × 60 passages = 3 M; products ≈ 0.5 M. At 768 dims that is
  ~10.7 GB as `vector` (4 bytes/dim) or ~5.4 GB as `halfvec` (2 bytes/dim) before index overhead.

## 2. Target infrastructure

| Component | Launch (0–200 tenants) | 1,000 tenants | Notes |
|---|---|---|---|
| Console (Next.js) | Vercel Pro | Vercel Pro | Static + RSC; cheap at this scale |
| API (HTTP profile) | 2 × 1 vCPU / 1 GB | 3–4 × 1 vCPU / 1 GB | Stateless, behind a load balancer; autoscale on CPU |
| Workers (queue profile) | 2 × 1 vCPU / 2 GB | 4–6 × 2 vCPU / 2 GB | Respond-path concurrency ~20 per process; autoscale on queue depth |
| Postgres (Supabase) | Pro + Large (2 dedicated vCPU, 8 GB) | Pro + XL → 2XL (4–8 vCPU, 16–32 GB) | Supavisor transaction pooling; PITR on; read replica for insights at 1k |
| Redis | 1 GB with AOF persistence | 2–4 GB, AOF, HA | BullMQ needs a long-lived connection-billed Redis, not per-request billing |
| Object storage | Supabase Storage | Supabase Storage or S3 + CDN | Product photos via signed URLs (fixes the "photos can't be sent on WhatsApp" gap) |
| Edge | Cloudflare DNS + TLS | + WAF rules, rate limits on public widget endpoints | |
| Observability | Sentry + logs | + OpenTelemetry traces per turn, uptime checks, status page | |

Reference prices (Supabase, checked 2026-10-06): Pro $25/mo incl. $10 compute credit; Large
$110, XL $210, 2XL $410 per month; PITR $100/mo per 7 days of retention.

## 3. Steps, in order

### Phase A: before the first paying tenant (blocking)

1. **Staging environment** identical to production (separate Supabase project, Redis, Meta test
   app). Every merge deploys to staging first.
2. **Split API and worker processes** in production (same image, two profiles) and set
   per-queue concurrency.
3. **Fail-closed configuration.** Boot refuses to start without webhook secrets, encryption keys
   and DB URL (v2 already does this for the secrets it adds).
4. **Global rate limiting** in Redis: per tenant, per widget key, per IP on public endpoints.
5. **Provider limits.** Raise LLM / embedding / ASR quotas to ≥ 2× peak concurrency; configure
   a secondary chat provider for circuit-breaker failover.
6. **Backups.** Turn on PITR; run a restore drill into staging and write down the time it took.
7. **Load test** at 50 → 120 concurrent conversations with recorded traffic (the eval corpora)
   against staging; record p95 webhook ack and p95 reply.
8. **Security.** Run the red-team pass (L7), a dependency audit, and an external pentest before
   the public launch; enable 2FA for operator accounts.
9. **Compliance.** Saudi and UAE PDPL review, DPA template, sub-processor list; ZATCA
   e-invoicing for KSA invoices (Stripe Tax + a ZATCA-compliant invoicing provider).
10. **Meta.** Business verification, Tech Provider onboarding, App Review with every permission
    in one submission, app switched to Live.

### Phase B: 0–200 tenants (pilots and early paid)

11. Shadow mode for 3–5 pilots, then real-traffic evals; fix quality bars before scaling sales.
12. **Usage metering live** (`usage_events`) and the operator cost view checked weekly: margin per
    plan, heaviest tenants, cost per conversation.
13. **Alerting:** queue depth, respond-path p95, provider error rate, webhook signature failures,
    stuck tickets, Meta number quality changes.
14. Customer success loop: weekly knowledge-gap email, churn signals (no logins, rising hand-off
    rate).

### Phase C: 200–1,000 tenants

15. **Partition `messages`** (monthly) or enforce the retention policy; move insights queries to a
    read replica.
16. **Vectors:** switch to `halfvec` HNSW indexes with tenant filtering (pgvector iterative scans),
    or partition KB by tenant hash if recall drops.
17. **Autoscaling** on queue depth for workers; separate queues (and worker pools) for campaigns
    and broadcasts so a big send never delays live replies.
18. **Campaign throughput:** respect each WhatsApp number's messaging tier; spread sends;
    per-tenant spend caps stay on.
19. **SLOs published** (99.9%), status page, incident runbook, on-call rota.
20. **Data residency option** (KSA/UAE region) for regulated tenants (clinics).

## 4. Unit economics (fill in with real numbers)

Per conversation cost = AI tokens × model price + ASR minutes + vision calls + embedding
re-indexing (small) + infrastructure share. WhatsApp message fees are paid by the tenant on its
own WhatsApp Business Account: service replies inside the 24 h window are free; templates are
billed per delivered message by category and country. That is why free-form broadcasts are
limited to the window and everything else goes through templates.

Worked example to replace with measured values: 5 turns × ~5k input + ~300 output tokens per
turn ≈ 26k tokens per conversation. Multiply by the platform model's price from the
`model_prices` table. At 1,000 conversations a month the AI cost of a Starter workspace must stay
well under 30% of its price, or the plan limits must move.

BYOK plans move that AI cost to the tenant, which is why they are priced lower.

## 5. Monthly infrastructure budget (order of magnitude, before AI)

| Item | Launch | 1,000 tenants |
|---|---|---|
| Supabase (Pro + compute + PITR) | ~$235 | ~$335–$535 + replica |
| API + workers (containers) | ~$60–$120 | ~$250–$500 |
| Redis | ~$15–$30 | ~$60–$150 |
| Vercel Pro | ~$20 per seat | ~$20 per seat + usage |
| Sentry, uptime, email, Cloudflare | ~$50 | ~$150–$300 |
| **Total before AI** | **≈ $400–$500** | **≈ $900–$1,700** |

AI provider spend dominates at scale and is tracked per tenant in `usage_events`.

## 6. Launch blockers specific to the Gulf

- ZATCA (Fatoorah) e-invoicing for Saudi customers.
- PDPL (KSA) and UAE PDPL sign-off; Arabic privacy policy and terms (already published in v1).
- Local payment methods for our own billing (Mada, Apple Pay); Stripe availability per country.
- Native-speaker review of Arabic console strings and agent replies.
