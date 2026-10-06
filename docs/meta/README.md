# Meta / WhatsApp Developer Docs — Reference Snapshot

Reference material pulled from official Meta for Developers documentation (plus a few corroborating third-party sources for pricing figures) to support the `meta-graph`, `whatsapp`, `meta-channel`, `webhook`, and `privacy` modules in `apps/api/src/modules/`. This is documentation-only reference material — it does not change any shipped backend task or contract in `docs/HANDOFF.md`.

**Last refreshed: 2026-09-26 — re-fetch these when Meta API behavior seems off or ~every few months.**

## Files

- [app-review-submission.md](./app-review-submission.md) — Step-by-step runbook for business verification, App Dashboard fields, callback URLs, and per-permission justifications + screencast scripts for the single App Review submission.
- [whatsapp-cloud-api.md](./whatsapp-cloud-api.md) — Cloud API overview: current Graph API version, WABA/phone number concepts, sending messages, media upload flow.
- [embedded-signup.md](./embedded-signup.md) — Full Embedded Signup flow: FB.login/config_id, `message` event + `WA_EMBEDDED_SIGNUP`, `sessionInfoVersion` history (v2/v3/v4), required scopes, Facebook Login for Business config clarification — highest-value doc for the current `missing_session` debugging.
- [messenger-instagram-login.md](./messenger-instagram-login.md) — Facebook Login for Business permissions for Messenger + Instagram DMs, Conversations API, how it differs from WhatsApp's model.
- [webhooks.md](./webhooks.md) — Verification handshake, `messages`/`statuses` payload shapes, signature verification, subscription setup.
- [data-deletion-deauthorization.md](./data-deletion-deauthorization.md) — Signed request format/verification, Data Deletion Request callback response contract, Deauthorize callback behavior.
- [message-templates.md](./message-templates.md) — Template categories, approval flow, quality rating system, Template Management API, auto-archival.
- [pricing-conversations.md](./pricing-conversations.md) — Current per-message pricing model (post July 2025 shift), category rates, the reported Oct 1 2026 window-billing change to re-verify closer to that date.

Each file cites its source URL(s) at the top and bottom so it can be re-verified/re-fetched later.
