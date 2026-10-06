# WhatsApp Embedded Signup

> Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/ , .../embedded-signup/implementation , .../embedded-signup/version-4 , .../embedded-signup/version-3 , .../embedded-signup/versions — fetched 2026-09-26

This is the highest-value doc right now given the active `missing_session` / `sessionInfoVersion` / config-id debugging. Read this fully before touching `meta-connect.service.ts`, `meta-connect-handshake.store.ts`, or the frontend FB.login integration.

## What Embedded Signup actually is

Embedded Signup is a JS-SDK-driven flow, **built on top of the Facebook Login for Business product**. It does three things: collects business info from the customer, auto-provisions the WhatsApp assets (WABA, phone number) on Meta's side, and grants your app access to those assets. On success it hands back to your app: **WABA ID, business phone number ID, business portfolio ID, and an exchangeable "code"** — not a token directly.

## Facebook Login for Business config vs "wa_embedded_signup" config — the actual distinction

There is **one underlying config mechanism** (a Facebook Login for Business configuration created in App Dashboard → Facebook Login for Business → Configurations), not two separate systems. The config record itself declares:
- which permissions/scopes to request (`whatsapp_business_management`, `whatsapp_business_messaging`, and optionally others like `business_management`)
- what additional business info to collect during the flow
- the assets in scope (WhatsApp specifically, vs also Pages/ad accounts/catalogs for other Facebook Login for Business use cases)

The `config_id` you pass into `FB.login()` is the ID of **this specific configuration record** — so "wa_embedded_signup config" and "Facebook Login for Business config" are the same object; the confusion in past debugging sessions was almost certainly passing the wrong config's ID (e.g., a generic Facebook Login config not scoped/created for WhatsApp embedded signup, or a stale config_id from a different Meta app/business portfolio) rather than there being two distinct ID types.

**Action item for this codebase:** verify in `meta-connect.service.ts` / wherever `config_id` is sourced (env var, DB) that it points to a config created specifically under the WhatsApp Embedded Signup setup wizard in App Dashboard (App Dashboard → WhatsApp → Embedded Signup / "Embedded Signup Integration Helper" tool), and that it belongs to the same Meta App ID used in `FB.init()`.

## Required scopes

- `whatsapp_business_management` — needed if your app manages onboarded customers' WABA settings and templates.
- `whatsapp_business_messaging` — needed if your app sends/receives messages, or manages the customer's business phone number settings.

Both are typically requested together for a full-service SaaS like this one.

## Implementation flow (v4, current)

### 1. SDK init

```js
window.fbAsyncInit = function() {
  FB.init({
    appId: '<APP_ID>',
    autoLogAppEvents: true,
    xfbml: true,
    version: '<GRAPH_API_VERSION>'   // e.g. v23.0 — match your backend Graph API version
  });
};
```

### 2. Message event listener (session logging)

Embedded Signup posts progress/completion events to the opener window via `postMessage`. You MUST register this listener **before** calling `FB.login`, and validate the origin:

```js
window.addEventListener('message', (event) => {
  if (!event.origin.endsWith('facebook.com')) return;
  let data;
  try { data = JSON.parse(event.data); } catch { return; }
  if (data.type === 'WA_EMBEDDED_SIGNUP') {
    // data.event: 'FINISH' | 'CANCEL' | 'ERROR'
    // on FINISH: data.data contains phone_number_id, waba_id, business_id
  }
});
```

Event types: `FINISH` (success — includes phone number ID, WABA ID, business portfolio ID), `CANCEL` (user abandoned), `ERROR`.

**This is the mechanism for "session logging via the `message` event"** referenced in past debugging — if `missing_session` errors occurred, the likely causes are: (a) listener registered after `FB.login` fired and the flow completed in a race, (b) origin check silently swallowing the real event due to a wrong domain, or (c) the popup being blocked/closed before postMessage fired.

### 3. `FB.login()` call

```js
FB.login(fbLoginCallback, {
  config_id: '<CONFIGURATION_ID>',      // the Facebook Login for Business config scoped to WA embedded signup
  response_type: 'code',
  override_default_response_type: true,
  extras: {
    setup: {},                          // pre-fill data goes here (see pre-filled-data doc)
    featureType: 'whatsapp_business_app_onboarding',
    sessionInfoVersion: '3'             // version 2/3 required this explicitly; v4 flow uses an empty extras object and Meta docs describe session info as sent automatically
  }
});
```

### 4. `sessionInfoVersion` — what it actually controls, and version history

- **Version 2**: partners had to *manually* set `sessionInfoVersion` in `extras` to receive the richer session-info callbacks at all; omitting it meant you got a degraded/minimal payload.
- **Version 3**: session info is sent back for *all* flows automatically — you may still pass `sessionInfoVersion: '3'` but it's less load-bearing than in v2.
- **Version 4** (current, released 2025-10-08): uses a deliberately empty `extras` object; session info handling is transparent, no `sessionInfoVersion` field needed/documented.
- **Deprecation:** Embedded Signup **v2 will be deprecated 2026-10-15**. If this codebase is still targeting v2 behavior (e.g., hardcoded `sessionInfoVersion: '2'` in `meta-connect-handshake.store.ts`), migrate to v3/v4 before that date — this is likely relevant to the `missing_session` bug since mixing a v2-style `sessionInfoVersion` value with v3/v4 SDK behavior is a plausible root cause.

### 5. Token exchange

The `code` returned to the opener via the login callback (not the postMessage event — those are separate signals: postMessage tells you the *UI flow* outcome, the login callback's `code`/`authResponse` is what you exchange for a token) is **short-lived, ~30 seconds**. Send it to your backend immediately (`meta-token.service.ts`) to exchange for a long-lived business token via the standard OAuth token exchange endpoint.

### 6. App Dashboard setup requirements

- Add your app's domain to "Allowed Domains for the JavaScript SDK" and to "Valid OAuth Redirect URIs".
- Enable HTTPS, Client OAuth Login, and Web OAuth Login on the Facebook Login for Business product settings.
- Subscribe to the `account_update` webhook field for async completion/error notifications (useful if the client-side postMessage is missed, e.g. user closed tab).

## Sources

- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-3
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/versions
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/pre-filled-data
