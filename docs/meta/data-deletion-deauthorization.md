# Data Deletion Request Callback + Deauthorize Callback

> Source: https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback — fetched 2026-09-26 (Deauthorize callback details supplemented from general Meta App Review requirements; re-verify against https://developers.facebook.com/docs/facebook-login/guides/permissions/checklist and the App Dashboard "Deauthorize Callback URL" field docs before relying on specifics not restated here)

Both callbacks are **mandatory for Meta App Review / production ("Live") mode** for any app using Facebook Login (which includes WhatsApp Embedded Signup and Facebook Login for Business flows in this codebase). This maps to `apps/api/src/modules/privacy/meta-deauthorize.service.ts`, `meta-data-deletion.service.ts`, `meta-signed-request-verifier.service.ts`.

## Signed Request format (shared by both callbacks)

Meta POSTs a single form field, `signed_request`, shaped as:

```
<base64url(signature)>.<base64url(payload_json)>
```

Payload JSON contains at minimum: `algorithm` (`HMAC-SHA256`), `issued_at`, `user_id` (app-scoped user ID).

### Verification steps (must happen before trusting any field)

1. Split on `.` into `encoded_sig` and `encoded_payload`.
2. Base64url-decode both.
3. Recompute `HMAC-SHA256(app_secret, encoded_payload_raw_string)`.
4. Compare byte-for-byte (constant-time compare) against the decoded signature.
5. Reject (4xx) if they don't match, or if `algorithm` isn't `HMAC-SHA256` — don't trust an attacker-supplied algorithm field.

This verification logic should live in `meta-signed-request-verifier.service.ts` and be shared by both the deletion and deauthorize handlers — don't duplicate the HMAC logic per-callback (DRY per project engineering principles).

## Data Deletion Request Callback

- Endpoint must be public HTTPS, no auth required on the endpoint itself (Meta can't authenticate to you beyond the signed request).
- Registered in App Dashboard under "Data Deletion Request URL".
- On receipt: decode + verify `signed_request` → extract `user_id` → **queue/perform deletion of that user's data** (async is fine and recommended — don't block the response on a long-running deletion job).
- Required JSON response, returned immediately:

```json
{ "url": "<status_check_url>", "confirmation_code": "<alphanumeric_code>" }
```

- The `url` should be a page (can be on your own domain) where the user can check status using `confirmation_code` — this must actually work, Meta's review checks it.
- Wrong response shape (missing either field, wrong content-type) gets flagged as non-functional during App Review.

## Deauthorize Callback

- Fired when a user removes your app's access via Facebook/Instagram/WhatsApp account settings ("deauthorizes" your app).
- Registered in App Dashboard under "Deauthorize Callback URL".
- Receives the same `signed_request` POST format as above (verify identically).
- On receipt: revoke/invalidate any stored tokens tied to that `user_id` and mark the associated tenant/channel connection as disconnected in your DB — this is the trigger to stop treating a tenant's WhatsApp/Messenger connection as live.
- **Response requirement is minimal** — Meta just needs a `200` acknowledgment; no required JSON body (unlike the deletion callback). Still respond quickly; do heavier cleanup async.
- App Review requires both this and the Data Deletion Request URL configured before an app using Facebook/Instagram/Threads login can go Live.

## Action items for this codebase

- Confirm `meta-deauthorize.service.ts` actually revokes the tenant's stored WhatsApp/Meta tokens and flips connection status — deauthorization is a real-world signal (user removed access in FB settings), not just a compliance checkbox.
- Confirm `meta-data-deletion.service.ts` returns the `{url, confirmation_code}` shape exactly, and that the status-check `url` resolves to something real, not a 404 placeholder.

## Sources

- https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback
