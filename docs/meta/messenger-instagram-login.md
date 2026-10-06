# Facebook Login for Business + Messenger / Instagram Messaging

> Source: https://developers.facebook.com/documentation/business-messaging/messenger-platform , .../instagram-messaging , .../messenger-platform/overview , .../instagram-platform/overview , .../instagram-platform/instagram-api-with-facebook-login — fetched 2026-09-26

## Relationship between the pieces

If the app uses **Facebook Login for Business**, it accesses Instagram DMs through the **Messenger Platform's Instagram Messaging API** — Instagram messaging is not a separate product from Messenger's perspective, it's one more channel routed through the same webhook/Conversations model. There are actually two distinct Instagram integration paths Meta documents:

1. **Instagram API with Facebook Login for Business** — Instagram Business/Creator account must be linked to a Facebook Page; auth goes through Facebook Login for Business (this is almost certainly the path relevant to `meta-channel/`, since it shares the same config/token model as WhatsApp Embedded Signup and Facebook Login).
2. **Instagram API with Instagram Login** — direct Instagram-native login, no Facebook Page linkage required. Different permission set, different login SDK entry point. Confirm which one this codebase targets before assuming permission names below apply as-is.

## Required permissions (Facebook Login for Business path)

- `instagram_basic` — read Instagram professional account info.
- `instagram_manage_messages` — send/receive Instagram DMs.
- `pages_manage_metadata` — needed to manage the Page's webhook subscription fields.
- `pages_messaging` — Messenger (Facebook Page) DM send/receive.
- `pages_show_list` — enumerate Pages the user manages, needed to let a customer pick which Page/IG account to connect during onboarding.
- `business_management` — dependency for the above; needed for system-user token management (same as WhatsApp).

A Page access token is required, and it must be requested by a user with the "MESSAGING" task permission on that Page.

## How messaging works (both channels)

1. End user sends a message to your business Page or linked Instagram professional account.
2. Meta fires a webhook notification to your registered endpoint (same webhook subscription mechanism as WhatsApp, different `object` type — `page` for Messenger/Instagram vs `whatsapp_business_account` for WhatsApp).
3. Your app calls the Graph API (Conversations API) to fetch/reply within the messaging window.
4. **24-hour standard messaging window** applies, same shape as WhatsApp's customer service window — outside it you need message tags (Messenger) or are restricted (Instagram) rather than WhatsApp's template system.

## Conversations API

The Conversations API (`/me/conversations`, `/<PAGE_ID>/conversations`) lets you enumerate and fetch message threads across Messenger/Instagram without needing to reconstruct state purely from webhook events — useful for backfill/reconciliation in `meta-webhook.controller.ts` or `whatsapp-number-resolution.service.ts`-equivalent logic if this SaaS extends resolution logic to Messenger/Instagram numbers.

## Gotchas

- Instagram Messaging shares infra with Messenger but has its own feature docs tree (templates, quick replies, sender actions, human handoff) under `instagram-messaging` — don't assume 1:1 feature parity with WhatsApp templates; Instagram/Messenger use "message tags" for outside-window sends, not an approved-template system.
- App Review is required for `instagram_manage_messages` and `pages_messaging` in production (Advanced Access) — dev-mode/test-user access is limited to admins/testers of the app.
- If this SaaS's `meta-channel/` module is currently WhatsApp-only, confirm whether Messenger/Instagram is actually in scope for D-series work in GULF_PARITY_PLAN.md before implementing — this doc is reference material only, not a signal to start building it.

## Sources

- https://developers.facebook.com/documentation/business-messaging/messenger-platform
- https://developers.facebook.com/documentation/business-messaging/instagram-messaging
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview
- https://developers.facebook.com/docs/instagram-platform/overview/
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages
