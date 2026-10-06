# Clarly 2.0 — Merge Conflicts and Decisions

Every place Autologic and Clarly v1 disagree, what v2 does, and why. **Resolved** items were
decided during the merge using the owner's brief: Autologic is the feature base, Clarly is the
engine and the UI, the market is international with the GCC first. **Needs owner** items cannot
be settled from the code and are listed again at the end.

| # | Conflict | Autologic | Clarly v1 | v2 decision | State |
|---|---|---|---|---|---|
| C1 | Which codebase is the base | Next 14 JS monolith on Vercel | NestJS + Next 16 TS monorepo | Clarly engine, Autologic features ported in (see ARCHITECTURE §1) | Resolved |
| C2 | Tenant model | `clients` row = one login, `business_type` | `tenants` + Supabase users with `admin` / `agent` roles | Clarly's; `business_type` → tenant `vertical` (`commerce` / `services` / `hybrid`) | Resolved |
| C3 | Data access | Service-role key, isolation by `.eq('client_id')` in code | RLS forced, `withTenantTx()` | RLS. Operator reads use an explicit, audited path | Resolved |
| C4 | Message processing | LLM call inside the webhook request; `setTimeout` debounce; first entry only | Queue + workers, burst coalescing, every entry | Queue | Resolved |
| C5 | Two bot modes vs one agent | Separate locked prompts per business type | One agent loop, tools + KB, policy sections | One agent. A's locked rules become prompt sections enabled by vertical / tools. Bangla-market rules become a locale section. Needs an eval pass before pilots | Resolved |
| C6 | AI providers | "One provider runs everything" (Gemini or OpenAI, OpenRouter for platform), BYOK, Gemini 768-d embeddings | Mixed adapters: DeepSeek chat, Gemini vision, Qwen embeddings, HF ASR, Cohere rerank | C's ports. Add OpenAI + OpenRouter adapters. Operator picks the platform chat provider. BYOK covers generation only; **embeddings are always platform-owned** with model provenance per row | Resolved |
| C7 | Embedding space | 768-d `gemini-embedding-001` | `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` env | C's config. Provenance column + re-embed job stay mandatory | Resolved |
| C8 | Hand-off | `[[HANDOFF]]` marker, `needs_human` flag, push + email | Tickets, confidence line, holding reply, stuck-ticket alert | C's tickets. A's lexicon and push notification are merged in | Resolved |
| C9 | Broadcasting | Free-form messages inside the 24 h window | Approved templates to consented segments | Both. Free-form only to recipients inside the window; everyone else needs a template | Resolved |
| C10 | Design system | Maroon "Obsidian", inline styles | Paper / ink / lime, Tailwind 4 + shadcn, RTL | Clarly's (owner's requirement). Nothing of A's styling is copied | Resolved |
| C11 | Billing | SSLCommerz + manual txn approval, BDT, slider baskets, BYOK half price | Stripe checkout, dunning, entitlement guard | Stripe primary. `manual` provider for markets without Stripe. Slider baskets deferred | Resolved |
| C12 | Plan limits | Replies, products, documents, assistant questions, channels, per-day or per-month | Monthly message limit + spend cap | Merged catalogue (see FEATURE_MATRIX, Billing) | Resolved |
| C13 | Store import | One-shot Woo / Shopify import + URL scraping | OAuth sync (Shopify, Woo, Salla, Zid) + webhooks | C's sync. URL scraping kept as an extra import path | Resolved |
| C14 | Language set | English + Bangla | Arabic (default) + English | `ar`, `en`, `bn`; default locale follows the visitor (Arabic for GCC) | Resolved |
| C15 | Time zone | Hard-coded `Asia/Dhaka` in the booking prompt | none | Per-tenant IANA time zone | Resolved |
| C16 | Framework versions | Next 14 / React 18 | Next 16 / React 19 | Clarly's | Resolved |
| C17 | Operator console | Full `/admin` | none (scripts) | Port A to `/platform`, separate `platform_admins` table, audited | Resolved |
| C18 | Mobile apps | Two Capacitor Android apps on tellmoreai.com | none | PWA first; Capacitor shell after web parity | Resolved |
| C19 | Clarly v1 plan docs | — | `CLAUDE.md` points at `docs/GULF_PARITY_PLAN.md` and `AGENT_LIVE_TEST_PLAN.md`, both deleted in `834c0b6` | v2 docs live in `docs/v2/`; the deleted files are recoverable from git (`git show 834c0b6^:docs/GULF_PARITY_PLAN.md`). `CLAUDE.md` updated to point at v2 | Resolved |
| C20 | SheetJS install source | — | `xlsx` pulled from `cdn.sheetjs.com` at install time | Vendored tarball in `vendor/` so installs are reproducible | Resolved |
| C21 | Brand and domain | TellMore AI, tellmoreai.com, partner white-label | Clarly | Clarly. White-label deferred | **Needs owner** |
| C22 | Live Autologic tenants and their data | In production with real businesses | — | One-time migration script (clients → tenants, products, KB with re-embedding, conversations) is possible. Needs a go / no-go and a date | **Needs owner** |
| C23 | Final pricing per market | BDT packages | SAR draft | The plan catalogue supports any currency; numbers need a unit-economics sheet | **Needs owner** |
| C24 | Meta apps | A's own Meta app (FB + IG apps) | C's Meta Tech Provider app | v2 uses **one** Meta app (C's, Tech Provider). A's tenants must reconnect if migrated | **Needs owner** |
| C25 | Google Cloud project for Calendar | A's project, verified consent screen | none | v2 needs its own OAuth client (or reuse A's project) | **Needs owner** |

## What the owner needs to decide

1. **C21 brand/domain**: confirm "Clarly" is the brand and which domain the API and console live on.
2. **C22 migration**: whether TellMore AI's live tenants move to v2, and when.
3. **C23 pricing**: final plan numbers per currency (SAR first).
4. **C24 Meta app**: confirm v2 runs on Clarly's Meta app only.
5. **C25 Google OAuth**: reuse Autologic's verified Google Cloud project, or create a new one (needs verification again).
