# Meta App Review — Submission Runbook

Created 2026-10-01. Covers GULF_PARITY_PLAN Phase 0.1, 0.3, 0.4 and Phase 4 step 1. Work the
sections in order: each one blocks the next. Re-verify field names in the App Dashboard as you go;
Meta renames them often.

## Fixed values (do not vary these anywhere)

Business verification fails on any mismatch between the portfolio, the document and the website.
The website reads all of these from `apps/web/src/lib/legal/company.ts`.

| Field | Value |
|---|---|
| Legal name (exactly as on certificate) | شركة الطاقات المثمرة للمقاولات شركة شخص واحد |
| Legal name (English, used on site) | Empowering Energy (confirmed by founder 2026-10-01) |
| Commercial Registration | 1010632197 |
| VAT number | 310559487400003 |
| Address | King Abdulaziz Road, Al Muruj District, Riyadh 12282, Saudi Arabia |
| Website | https://clarly.esap.ai |
| Privacy contact | privacy@clarly.esap.ai — **mailbox must exist and receive mail** |
| Business phone | +966 55 329 1748 (must be reachable; Meta may call or SMS it) |

## Step 1 — Infrastructure on the real domain

1. **Web**: add `clarly.esap.ai` to the Vercel project; add the CNAME at the `esap.ai` DNS host.
2. **API**: add `api.clarly.esap.ai` as a Render custom domain; add its CNAME. Then set on Render:
   `API_PUBLIC_BASE_URL=https://api.clarly.esap.ai`, `CONSOLE_BASE_URL=https://clarly.esap.ai`, and
   add `https://clarly.esap.ai` to `CORS_ORIGINS`.
3. **Supabase Auth**: Site URL and redirect URLs → `https://clarly.esap.ai/**`.
4. **Mailbox**: create `privacy@clarly.esap.ai` (or a forward) and send it a test email.
5. **Render free tier (accepted risk, 2026-10-01)**: the service sleeps after 15 min idle.
   Before recording screencasts and before clicking Submit, open `https://api.clarly.esap.ai/health`
   to wake it, and keep it warm during review (an uptime pinger every 10 min is enough).
6. Verify each URL loads logged-out, in a private window, and returns 200:
   - https://clarly.esap.ai/legal/privacy
   - https://clarly.esap.ai/legal/terms
   - the footer on https://clarly.esap.ai shows the operating company and CR number.

## Step 2 — Business portfolio + verification (Phase 0.1)

In business.facebook.com → Settings → Business info:

1. Turn on 2FA for every admin (Security Center). Verification is refused without it.
2. Business info: legal name, address, phone and website **exactly** as in the table above.
3. **Domain verification**: Brand safety → Domains → add `esap.ai` and add the DNS TXT record
   Meta gives you. This proves you control the website on the portfolio.
4. Security Center → Start verification. Upload the **Commercial Registration** certificate as the
   primary document (it states the legal name and address). Keep the VAT certificate as the
   secondary document. Pick email (at `@esap.ai`) or phone as the confirmation method.
5. Expect 1-5 working days. Common rejection reasons: English name on the portfolio not matching
   the document, so put the Arabic legal name in the portfolio if the CR has no English name;
   address formatting; website not showing the company.

## Step 3 — Meta app settings (Phase 0.3)

developers.facebook.com → your app (type **Business**) → App settings → Basic:

| Field | Value |
|---|---|
| Display name | Clarly |
| App domains | `clarly.esap.ai`, `api.clarly.esap.ai` |
| Contact email | privacy@clarly.esap.ai |
| Privacy Policy URL | https://clarly.esap.ai/legal/privacy |
| Terms of Service URL | https://clarly.esap.ai/legal/terms |
| User data deletion | Data deletion callback URL → `https://api.clarly.esap.ai/meta/data-deletion` |
| App icon | 1024×1024 PNG, Clarly mark, no Meta/WhatsApp logos |
| Category | Business and Pages (or Messaging) |
| Business portfolio | the verified portfolio from Step 2 |

Other dashboard fields:

- **Facebook Login for Business → Settings**: Deauthorize callback URL →
  `https://api.clarly.esap.ai/meta/deauthorize`. Valid OAuth redirect URIs / allowed domains for
  the JS SDK → `https://clarly.esap.ai`.
- **Webhooks**: callback URL `https://api.clarly.esap.ai/webhooks/meta` for Page and Instagram
  objects; WhatsApp Business Account → `https://api.clarly.esap.ai/webhooks/whatsapp`.
  Verify token = Render `META_VERIFY_TOKEN`. Subscribe fields: WhatsApp `messages`; Page
  `messages`, `messaging_postbacks`, `feed`; Instagram `messages`, `comments`.
- **Login configurations**: one for WhatsApp Embedded Signup (→ `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`)
  and one for Facebook Login for Business (→ `NEXT_PUBLIC_FACEBOOK_LOGIN_CONFIG_ID`), each with the
  permissions below. Set `META_APP_ID` (Render) = `NEXT_PUBLIC_FACEBOOK_APP_ID` (Vercel), and
  `META_APP_SECRET` on Render.
- **Graph version (Phase 0.8)**: the code pins `v21.0`. Check its deprecation date on the
  Graph API changelog before submitting. If it ends before mid-2027, bump `META_GRAPH_VERSION`
  and `NEXT_PUBLIC_META_GRAPH_VERSION` together and run `test:meta-contract`.

## Step 4 — Tech Provider (Phase 0.4)

App Dashboard → WhatsApp → become a Tech Provider (needs Step 2 verified). Note the new-client
onboarding limit shown and the Tech Partner upgrade path.

## Step 5 — Permissions, justifications, screencasts (one submission)

Rules that cause most rejections:
- Screencast shows the **whole flow from logged-out**: Clarly login → connect → the Meta
  permission dialog → the feature using the data. English UI; add captions. No cuts mid-flow.
- Every permission requested must be used visibly in its screencast.
- Give reviewers a test login in "App Verification → Instructions": a seeded Clarly workspace
  email + password, plus the test WhatsApp number to message.
- Run `pnpm --filter api test:meta-contract` on submission day.

| Permission | What to write ("how we use it") | Screencast shows |
|---|---|---|
| `whatsapp_business_management` | Businesses connect their WhatsApp Business Account to Clarly through Embedded Signup. We read the WABA and phone numbers to register the number, subscribe our app to its webhooks, and manage message templates the business creates in Clarly. | Channels → Connect WhatsApp → Embedded Signup popup → number appears connected; Templates page creates a template |
| `whatsapp_business_messaging` | Clarly receives customer messages sent to the business's number and sends replies written by the business's AI agent or a human agent, within the 24-hour window or using approved templates. | Phone sends a WhatsApp message → it appears in Clarly inbox → AI reply arrives on the phone → agent takes over and replies |
| `business_management` | Required by Embedded Signup and Facebook Login for Business to read the business portfolio that owns the WABA, Page and Instagram account the user selects. | The asset-selection step of either connect flow |
| `pages_show_list` | Lists the Facebook Pages the user manages so they can choose which Page to connect to Clarly. | Connect Messenger → page picker |
| `pages_manage_metadata` | Subscribes our app to the connected Page's webhooks so messages and comments reach Clarly. | Page shows "connected"; a message then arrives (proves subscription) |
| `pages_messaging` | Receives Messenger messages to the business's Page and sends AI or human-agent replies. | Messenger message from a test user → inbox → reply arrives in Messenger |
| `pages_read_engagement` | Reads the Page's posts and their basic details so comment rules can be set per post and comments are shown with their post. | Comments page lists posts |
| `pages_read_user_content` | Reads comments people leave on the Page's posts so the agent can answer product questions such as price. | Comment "price?" on a post → appears in Clarly |
| `pages_manage_engagement` | Posts the agent's public reply to a comment and hides spam comments, according to the business's rules. | Same comment receives a public reply / private DM |
| `instagram_basic` | Reads the connected Instagram professional account's ID, username and media so the business can pick the account and its posts. | Connect Instagram → account shown |
| `instagram_manage_messages` | Receives Instagram Direct messages to the business and sends AI or human-agent replies. | IG DM → inbox → reply arrives on Instagram |
| `instagram_manage_comments` | Reads comments on the business's Instagram posts and Reels and replies to or hides them per the business's rules. | IG comment → reply appears under the post |

Data handling questionnaire answers (consistent with the privacy policy):
- Data processors: Supabase, Render, Vercel, self-hosted inference host (Qwen: chat, vision,
  embeddings), Cohere, Audar, Stripe, Resend, Sentry. Gemini is not used in production.
- Data is not sold, not used for ads, not used to train models; transcripts deleted after 90 days.
- Responsible entity: the legal entity above; country: Saudi Arabia.

## Step 6 — After approval

Switch the app to **Live**, re-run the live checks in AGENT_LIVE_TEST_PLAN, then Phase 4 steps 2-3
in GULF_PARITY_PLAN.

## Open items before submitting

- [x] English legal name confirmed: Empowering Energy
- [x] Business phone decided (+966 55 329 1748); add the same number to the portfolio
- [ ] `privacy@clarly.esap.ai` mailbox live
- [ ] Legal text (drafted 2026-10-01) reviewed by counsel, especially PDPL transfer wording
- [x] Gemini not used: production runs on the self-hosted model (`LLM/VISION/EMBEDDING_PROVIDER=qwen`).
      If any of these is ever switched to `gemini`, add Google to the privacy policy first and use a
      paid tier (free-tier inputs may be used for training)
- [ ] Confirm the subprocessor list matches production env (DeepSeek omitted: not in use since
      2026-09-30; add it back if `LLM_PROVIDER=deepseek` is ever set in production)
- [ ] Graph `v21.0` deprecation date checked
