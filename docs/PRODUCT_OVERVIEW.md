# Clarly — Product Overview

How Clarly works today, who it is for, how real merchants and their customers use it, what we
have built so far, and what comes next to reach an international standard.

Written 2026-10-05. Status facts come from [PRODUCT_GOALS.md](./PRODUCT_GOALS.md) (goal bars and
eval results), [GULF_PARITY_PLAN.md](./GULF_PARITY_PLAN.md) (phases) and
[HANDOFF.md](./HANDOFF.md) (shipped work). When those documents change, they win over this one.

---

## 1. What Clarly is, in one paragraph

Clarly is an AI customer-service and sales agent for Gulf businesses on **WhatsApp, Facebook
Messenger and Instagram**. A business uploads its own documents (price list, opening hours,
policies) and connects its channels, product catalog and online store. Clarly then answers
customers in Arabic (including Khaleeji, Egyptian, Levantine and Arabizi) and English, around
the clock. It answers only from the business's own information, cites where each answer came
from, finds products from a description or a photo, takes orders, tracks deliveries, and
**hands the chat to a person the moment it shouldn't answer**: low confidence, a forbidden
topic, an upset customer, or someone who asks for a human.

**Promise to the business:** *"It answers what it knows. It hands off what it doesn't."*

---

## 2. Where we are right now (honest snapshot)

| Area | State |
|---|---|
| Product build (Phases 1–3, 5–7) | **Built**: backend + console for every core feature (see §8) |
| Proven on real traffic | **Not yet.** No real message has gone customer → Meta → Clarly → customer. All Meta, store and courier integrations are tested against recorded fixtures and contracts only |
| Quality bars (eval) | Several bars **fail** today (accuracy, false/missed escalation, speed). See §8.3 |
| Public website | Live design: Arabic-first scroll-story landing page, product, pricing, waitlist, legal pages |
| Sign-up | **Waitlist only.** Public sign-in/sign-up is hidden (`WAITLIST_ONLY` in `apps/web/src/lib/launch.ts`); the team reaches `/login` by typing the URL |
| Paid launch | Waits on Meta business verification + App Review (Phase 0/4, founder-owned) |

In short: **the product shape is complete, the quality and live-proof work is what stands
between us and launch.**

---

## 3. How it works, end to end

```
 Customer (WhatsApp / Messenger / Instagram DM / post comment)
        │  "Salam, do you have a cleaning slot tonight? How much?"
        ▼
 Meta (Cloud API / Graph webhooks)  ──►  Clarly API (NestJS)
                                            │
            ┌───────────────────────────────┼─────────────────────────────────┐
            ▼                               ▼                                 ▼
  Understand the message          Retrieve from the merchant's         Tools (when needed)
  • text, Arabic dialects,        knowledge base                       • product search (catalog,
    Arabizi, English              • documents split into passages        photo → product)
  • voice note → transcript       • vector search + rerank             • create order
  • photo → product match         • only the merchant's data            • track shipment (courier)
            │                       (tenant-isolated, RLS)              • store stock/price sync
            └───────────────────────────────┬─────────────────────────────────┘
                                            ▼
                         Draft answer + confidence score + guardrails
                         • off-limits topics (e.g. medical advice, refunds)
                         • distress / complaint detection
                         • prompt-injection protection
                                            │
                     ┌──────────────────────┴───────────────────────┐
                     ▼                                              ▼
          Confident & allowed                          Not confident / forbidden /
          → reply in the customer's                    upset / "I want a person"
            language, with sources                     → hand off: ticket created,
            recorded for the team                        team notified, AI stops,
                                                          a person replies in the
                                                          SAME chat with full context
```

What the merchant's team sees: a **console** (web dashboard) with the shared inbox, tickets,
orders, deliveries, products, campaigns, insights and settings. Everything is available in
Arabic (right-to-left) and English.

---

## 4. Who uses Clarly

There are three kinds of people involved.

| Who | Role | What they do in Clarly |
|---|---|---|
| **Business owner / manager** (our paying customer) | **Admin** | Sets up the workspace: connects WhatsApp/FB/IG, uploads documents, connects the store, sets the hand-off rules and confidence line, manages team seats, billing, templates and campaigns. Reads insights. |
| **Front-desk staff / agents** | **Agent** | Work the inbox and ticket queue: claim handed-off chats, reply, hand back to AI, resolve tickets, add tracking numbers. |
| **The business's customers** (end users) | — | Never see Clarly as an app. They just message the business on WhatsApp, Messenger or Instagram like they always do, and get fast, correct replies. |

**Who keeps the subscription:** the **business owner** (clinic owner, shop owner, operations
manager, or a group's head of customer service). They pay because Clarly replaces or extends
front-desk hours, stops lost sales at night, and shows the numbers to prove it (resolution
rate, first-response time, chats handled while closed).

---

## 5. Potential customers (who we sell to)

Target market: **GCC** (Saudi Arabia, UAE, Kuwait, Qatar, Bahrain, Oman). Customers there
already run their business on WhatsApp and Instagram; most of their questions repeat; many
come after hours; and the language mix (dialects + English + Arabizi) defeats generic bots.

| Segment | Why they need it | What they use most |
|---|---|---|
| **Clinics** (dental, dermatology, physio, vet) | Booking and price questions all night; strict "no medical advice" rule | Knowledge base answers, off-limits topics, hand-off to a nurse, reminders via templates |
| **Instagram-first retail** (abayas, perfume, cosmetics, electronics) | DMs and comments asking "price?", "available in black?", photos of products | Photo → product → price, comment auto-reply, order capture, delivery tracking |
| **Online stores** on Salla, Zid, Shopify, WooCommerce | "Where is my order?" floods support; stock changes daily | Store sync, order read-back, courier tracking (Aramex, SMSA, Naqel, J&T) |
| **Restaurants & catering** | Menus, quotes, allergy questions, event orders | Knowledge base, safety escalation (allergies), order capture, campaigns |
| **Service businesses** (salons, gyms, real-estate offices, car services) | Repetitive questions, lead capture, follow-ups | Knowledge base, intake fields, Hot/Warm/Cold labels, campaigns |
| **Groups and chains** (later, Scale tier) | Several branches/numbers, compliance needs | Multiple numbers, audit log, data export, webhooks |

**Who will churn (and why we design against it):** businesses with very low message volume
(little value), or ones whose team ignores hand-offs (customers wait). Stuck-ticket alerts,
insights and the knowledge-gap report exist to keep the value visible.

---

## 6. Real-life examples

### Example A — Lumen Dental Clinic, Riyadh (clinic)

**Setup (one afternoon).** Mona, the clinic manager, joins from the waitlist and gets her
workspace. She:
1. Connects the clinic's WhatsApp number through Meta Embedded Signup (Settings → Channels).
2. Uploads *Price list 2026.pdf*, *Opening hours.docx*, *Insurance partners.pdf*,
   *Aftercare – extractions.pdf* and *Our doctors.pdf*. Clarly splits them into ~60 passages.
3. Marks off-limits topics: *diagnosis, medical advice, medication doses, refund promises*,
   and sets the hand-off line at confidence **0.70**.
4. Adds two agents: Hala (on-call nurse) and Faisal (reception).
5. Tests in the **Playground** before going live.

**02:14, Thursday night.** Sara writes on WhatsApp:
> السلام عليكم، عندكم موعد تنظيف الليلة؟ وكم السعر؟

Clarly replies within seconds, in her dialect:
> وعليكم السلام! نعم، نفتح الليلة حتى الساعة 10. تنظيف وتلميع الأسنان بـ 250 ريال ويستغرق
> حوالي 45 دقيقة. أرسل لك رابط الحجز؟

The reply is built from *Opening hours §1* and *Price list p.2*; the console records those
sources and a confidence of 0.94. Sara books for 21:30.

**02:31.** Sara again: *"I had a tooth pulled on Sunday, it's still swollen and hurts a lot. Is
that normal?"* This is **medical advice**, an off-limits topic. Clarly does not guess:
> I'm sorry it hurts. I can't give medical advice, so I'm bringing in our on-call nurse now.

A ticket (#1182, "Pain after extraction", reason *off-limits: medical advice · 0.41*) appears in
`/tickets`. Hala gets notified, claims it, and replies in the same chat a minute later with the
whole conversation in front of her. If no one claims a ticket within 15 minutes, the whole team
is pinged.

**09:00.** The front desk opens with **zero** unanswered chats instead of 47. Mona's
**Insights** page shows chats answered while closed, median first-response time, and which
questions Clarly couldn't answer (e.g. *"Invisalign?"*). That tells her which document to
upload next.

**Why Mona keeps paying:** the night-time bookings alone cover the subscription, and her nurse
only sees the chats that truly need her.

---

### Example B — "Noor Abayas", Dubai (Instagram retail + Salla store)

**Setup.** Noor connects Instagram and Facebook (Facebook Login), WhatsApp, and her **Salla**
store. Products, prices and stock sync automatically. She turns on **comment auto-reply**.

**A customer comments** under a reel: *"price?"*. Clarly reads the intent (purchase), replies
publicly with a short answer and sends the details by **DM**. Spam comments can be hidden.

**In the DM,** the customer sends a **photo** of an abaya from a story and writes in Arabizi:
> 3indkom hatha bel aswad? size 54

Clarly matches the photo to the catalog, checks live stock for black / size 54, quotes the
real price, and when the customer says *"yes I want it"*, asks for the missing details
(name, area, phone) instead of inventing them, then **creates the order**. It confirms the
order back to the customer. The order shows in `/orders` for Noor's team to fulfil.

**Three days later:** *"وين طلبي؟"* (*Where is my order?*). Clarly looks up the shipment
with the courier (e.g. Aramex), and answers with the real status and ETA. It never guesses a
date, and never shows another customer's order. If the courier is down, it says it couldn't
check right now.

**Unhappy customer:** *"the abaya arrived torn, this is unacceptable"*. Clarly recognises a
complaint, keeps a calm tone, labels it, and opens a ticket for Noor's team. It does not
argue or promise refunds.

**Why Noor keeps paying:** comments and DMs convert into orders while she sleeps, and
"where is my order" no longer eats her day.

---

### Example C — "Bayt Catering", Kuwait (catering + campaigns)

- Customers ask for quotes for weddings and events. Clarly answers from the menu and policy
  documents. When someone mentions a **peanut allergy**, safety escalation is deterministic:
  the chat goes to a person every time.
- Before Ramadan, the owner builds a **segment** (customers who ordered in the last 6 months)
  and sends an **approved WhatsApp template** campaign with a spend cap. Sending is throttled
  to respect Meta limits.
- A customer replies *"yes, I want the iftar tray for 10 people on Friday"*. Clarly continues
  **in the context of the campaign** and takes the order.

---

## 7. The merchant's journey (from waitlist to daily use)

1. **Waitlist** (`/waitlist`, current public entry). We onboard in small batches and help each
   business verify its number.
2. **Workspace created** → Admin signs in (today by invitation; self-serve sign-up returns when
   `WAITLIST_ONLY` is switched off).
3. **Connect channels**: WhatsApp (Embedded Signup), Messenger + Instagram (Facebook Login).
   Health checks and one-click reconnect keep them working.
4. **Teach it**: upload documents to the Knowledge base; connect a store (Salla / Zid /
   Shopify / WooCommerce) or add products manually / by CSV; set business hours.
5. **Set the rules** (Settings → Agent / Policy): off-limits topics, hand-off confidence line,
   tone, intake fields to collect.
6. **Test** in the Playground, then go live.
7. **Daily use**: agents work `/inbox` and `/tickets`; orders and deliveries flow through
   `/orders` and `/deliveries`; the owner checks `/insights` weekly and fills knowledge gaps.
8. **Grow**: campaigns with approved templates; more numbers and seats as volume grows.

---

## 8. What we have built so far

### 8.1 Customer-facing capabilities

| Capability | Status |
|---|---|
| Answers from the merchant's own documents, with sources; confidence-based hand-off | Built |
| Off-limits topics, distress/complaint detection, deterministic safety escalation (allergy, health, incident) | Built |
| Prompt-injection guardrails, tenant isolation (row-level security) | Built; injection leak 0 and cross-customer leak 0 in evals |
| Arabic dialects (Khaleeji, Egyptian, Levantine), Arabizi, English, mixed | Built; dialect corpora 91–100/100 |
| Voice notes (transcription) and product photos (vision) | Built; voice-support 9/9 on the self-hosted ASR (targeted run) |
| WhatsApp (Embedded Signup, health, reconnect) | Built; live Meta test pending |
| Messenger + Instagram DMs (Facebook Login) | Built; live test pending |
| Comment auto-reply on FB/IG posts (reply / DM / hide) | Built; comment-intent accuracy 79.3% |
| Product catalog (CRUD, CSV, images, fuzzy + photo search) | Built |
| Store sync: Shopify, WooCommerce, Salla, Zid (+ order read-back) | Built; live-unverified (no merchant sandboxes) |
| Order capture in chat | Built |
| Delivery tracking: Aramex, SMSA, Naqel, J&T with ETAs | Built; live-unverified |
| Campaigns: segments, template checks, spend cap, throttled sending | Built; never sent live |

### 8.2 Merchant console (web, Arabic RTL + English)

Home, Inbox (unified, human takeover), Tickets (kanban: Open → Claimed → Resolved), Orders,
Deliveries, Products, Campaigns, Insights (resolution, escalations, first-response time,
knowledge gaps), Playground, and Settings: Agent, Channels, Store integrations, Knowledge base,
Team (Admin/Agent), Billing (trial, Stripe checkout, dunning emails), Policy, Templates, Data
export, Audit log, Webhooks, Close workspace (offboarding).

Also: Meta data-deletion and deauthorize callbacks, retention and data export, cookie consent,
published Privacy Policy and Terms (EN + AR) naming the operating entity.

### 8.3 Quality: built is not the same as proven

From [PRODUCT_GOALS.md](./PRODUCT_GOALS.md) (latest eval cycle 2026-09-30):

| Goal | Status | Main gap |
|---|---|---|
| 1. Correct answers from merchant knowledge | 🔴 | False escalation 6% (bar ≤5%), 2 missed escalations (bar 0); full 23-corpus × 5-run re-run needed |
| 2. Sell: right product, price, order | 🔴 | 6 wrong orders of 285 (bar 0); out-of-stock variant ordered as plain model |
| 3. Order tracking | 🔴 | Tracking resolution 72.7%, false escalation 27.3%; no courier sandbox |
| 4. Complaints, never lose an unhappy customer | 🔴 | Missed escalations not yet 0; end-to-end on a real channel not run |
| 5. Channels | 🟡 | No real webhook → agent → phone message yet |
| 6. Gulf dialects, voice, photos | 🔴 | A few dialect regressions; dialect voice samples need pilots |
| 7. Store sync | 🟡 | Contract tests only |
| 8. Campaigns | 🟡 | Never sent live |
| 9. Speed under load | 🔴 | Agent reply p95 > 5 s on many corpora; rerank/embedding stalls; no load test |
| 10. Data safety | 🟡 | Red team not run; PDPL legal review pending |
| 11. Run it all from the console | 🟡 | Billing E2E missing; some pages 500 locally (migration tracking) |
| 12. Mobile app / web widget | ⬜ | Not started |

---

## 9. Subscription and pricing

- **Model:** monthly (or yearly) SaaS subscription per workspace, with a free trial. Plans are
  served from `GET /billing/plans/public`; checkout and dunning are built on Stripe.
- **Meta message costs** are paid by the business on its own WhatsApp Business Account
  (we are a Meta Tech Provider, so there is no fixed per-number middleman fee).
- **Planned tiers** (shown on the landing page for illustration; final pricing needs the
  unit-economics sheet: LLM cost per conversation + Meta message pricing):

| Plan | Price (SAR, ex-VAT) | For |
|---|---|---|
| Early access | Free (now) | Waitlist pilots; we help verify the number |
| Starter | 299/mo (249/mo yearly) | One clinic or shop: 1 number, 1,000 chats/mo, 3 seats, 50 documents |
| Growth | 799/mo (666/mo yearly) | Busy teams: 3 numbers, 5,000 chats/mo, 10 seats, templates, insights, webhooks |
| Scale | Custom | Groups/chains: unlimited numbers, volume pricing, audit log, onboarding |

**What makes them stay:** after-hours bookings and orders captured; fewer repetitive chats for
staff; proof in numbers (resolution rate, first-response time, chats handled while closed);
and switching cost once their knowledge base, catalog and store are wired in.

---

## 10. Next phase: getting to launch

These are already in [GULF_PARITY_PLAN.md](./GULF_PARITY_PLAN.md); listed here in order.

1. **Hit the quality bars** (Goals 1–4, 6, 9): fix missed escalations, wrong orders and tracking
   resolution; cut latency (embedding host relocation, rerank timeouts, fewer model rounds);
   full eval re-run on a fixed build.
2. **First live messages in Meta Development mode** (L3 scripts on WhatsApp, Messenger,
   Instagram, Arabic + English).
3. **Phase 0 (founder-owned):** Meta business verification, Tech Provider onboarding, staging
   deploy, test assets, email DNS.
4. **Phase 4 (pre-launch):** App Review (one submission, all permissions), production deploy,
   switch the Meta app to Live, load test at 50–100 concurrent conversations, global rate
   limiting, billing E2E, final GCC pricing.
5. **Phase 5 (first 60 days):** 3–5 pilot merchants (clinics, Instagram retail, restaurants)
   in shadow mode → real-traffic eval → publishable case studies. Then switch `WAITLIST_ONLY`
   off.
6. **Phase 8:** mobile inbox app (F28), website chat widget (F29, only if pilots ask).

---

## 11. Beyond launch: what "international standard" needs

What mature global players (Intercom, Zendesk, respond.io, Gorgias) have that we should plan
for. Grouped by area, with a suggested priority.

### Trust, security and compliance
- **Saudi PDPL + UAE PDPL compliance** sign-off; DPA template for merchants; published
  subprocessor list (LLM, embedding, ASR vendors). *(P0, launch-blocking)*
- **Data residency option**: host data and models in-region (KSA/UAE cloud regions) for
  regulated customers (clinics, government-adjacent). *(P1)*
- **SOC 2 Type II**, later **ISO 27001**: needed for enterprise/chain deals. *(P2)*
- **Independent penetration test** and the planned red team (L7). *(P0)*
- Account security: **2FA**, SSO (Google/Microsoft, SAML for Scale), session management. *(P1)*
- Finer **RBAC** beyond Admin/Agent (branch managers, read-only auditors). *(P2)*
- Healthcare: a clear "not a medical device" position and HIPAA-style handling if we sell to
  clinics outside the GCC. *(P2)*

### Reliability and operations
- Published **SLOs/SLA** (uptime, reply latency), a public **status page**, incident process. *(P1)*
- **LLM provider failover** (automatic switching when a model host stalls). *(P1)*
- Load and chaos testing in CI; observability (traces per conversation, alerting). *(P1)*
- Backups with tested restore; disaster recovery targets (RPO/RTO). *(P1)*

### Product depth
- **Mobile inbox app** with push notifications for hand-offs. *(P1)*
- **Website chat widget**, then more channels (Telegram, SMS, voice calls) on demand. *(P2)*
- **Calendar/booking integrations** (Google Calendar, clinic systems): book the slot, not just
  send a link. *(P1 for clinics)*
- **CRM connectors** (HubSpot, Salesforce, Zoho) and a public **REST API + webhooks docs**. *(P2)*
- **AI quality loop for merchants**: thumbs up/down on answers, one-click "add this to the
  knowledge base" from a hand-off, A/B prompts per tenant. *(P1)*
- Multi-branch / multi-brand workspaces. *(P2)*

### Gulf-specific commerce and billing
- **ZATCA e-invoicing (Fatoorah)** compliant VAT invoices for Saudi customers; UAE VAT
  invoices. *(P0 for paid launch in KSA)*
- Local payment methods for our own billing: **Mada, Apple Pay, STC Pay**; BNPL awareness
  (Tabby, Tamara) for merchants' customers. *(P1)*
- Multi-currency pricing (SAR, AED, KWD, QAR, BHD, OMR). *(P1)*
- Listings on **Salla App Store, Zid App Market, Shopify App Store**: distribution channels. *(P1)*

### Language and accessibility
- Keep Arabic-first; add **Urdu, Hindi, Tagalog, Bengali** (large expat customer bases in the
  GCC), and French for North Africa expansion. *(P2)*
- **WCAG 2.2 AA** accessibility audit of the console and website. *(P1)*
- Native-speaker review of every Arabic string (console + agent replies). *(P1)*

### Go-to-market and support
- Case studies with real numbers from pilots; ROI calculator on the website. *(P1)*
- Help center (EN + AR), onboarding videos, in-app checklists. *(P1)*
- Customer success playbook: weekly "knowledge gaps" email to the owner, churn signals. *(P2)*
- Partner/agency program for resellers in each GCC country. *(P2)*

---

## 12. Open decisions and risks

- **Pricing** isn't final (needs the unit-economics sheet).
- **Model hosting**: self-hosted LLM/embedding hosts have stalled during evals; relocation or
  failover needed before real traffic.
- **Product photos on WhatsApp**: console-uploaded images can't be sent yet (no signed URLs).
- **Meta dependency**: App Review rejection or number-quality issues can delay launch; there is
  no second WhatsApp path by design (360dialog removed).
- **Corpus expectations** loosened during eval cycles need owner sign-off.

---

## 13. Glossary

| Term | Meaning |
|---|---|
| Tenant / workspace | One business using Clarly; its data is isolated from all others |
| Knowledge base | The merchant's uploaded documents, split into passages Clarly answers from |
| Hand-off / escalation | Clarly stops and a human takes over the same chat, via a ticket |
| Confidence line | The score below which Clarly hands off instead of answering |
| Off-limits topics | Subjects Clarly must never answer for this merchant (e.g. medical advice) |
| Template | A WhatsApp message pre-approved by Meta, required for business-initiated messages |
| Embedded Signup | Meta's in-app flow for a business to connect its WhatsApp number |
| Tech Provider | Our status with Meta: businesses connect through Clarly's own Meta app |
| Eval / corpus | Automated test conversations that measure accuracy, escalation and speed |
| `WAITLIST_ONLY` | Launch flag: public sign-up/sign-in hidden, waitlist is the only entry |
