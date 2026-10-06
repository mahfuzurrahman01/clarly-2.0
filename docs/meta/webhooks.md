# Meta Webhooks (WhatsApp / Messenger / Instagram)

> Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview , .../webhooks/create-webhook-endpoint/ , .../webhooks/reference/messages — fetched 2026-09-26

## Verification handshake

Meta verifies your callback URL with a `GET` request carrying:

- `hub.mode` = `subscribe`
- `hub.verify_token` = the token you configured
- `hub.challenge` = a random string

Your endpoint must: compare `hub.verify_token` to the value you stored, and if it matches, respond `200 OK` with the **raw `hub.challenge` value as the response body** (not JSON-wrapped). Any other response is treated as verification failure and Meta won't let you save the subscription. This is the standard pattern for `meta-webhook.controller.ts` — confirm it strips query params correctly and returns `text/plain`, not `application/json`.

## Subscribing to fields

1. App Dashboard → WhatsApp → Configuration → set Callback URL + Verify Token.
2. Once the GET handshake succeeds, a list of subscribable fields appears (`messages`, `message_template_status_update`, `account_update`, etc.) — select what you need.
3. Alternatively, subscribe programmatically via the Application Subscriptions API (`POST /<APP_ID>/subscriptions`) with an app access token — useful for automating this per-tenant if this SaaS provisions webhook subscriptions dynamically per WABA.

## Permissions required

- `whatsapp_business_messaging` — for `messages` (and calls) webhook fields.
- `whatsapp_business_management` — for every other WhatsApp webhook field (account/template/quality updates).

## Payload shape — incoming message

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "contacts": [{ "profile": { "name": "User Name" }, "wa_id": "16505551234" }],
        "messages": [{
          "from": "16505551234",
          "id": "wamid...",
          "timestamp": "1749416383",
          "type": "text",
          "text": { "body": "Message content" }
        }]
      }
    }]
  }]
}
```

## Payload shape — status update

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "<WABA_ID>",
    "changes": [{
      "field": "messages",
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550783881", "phone_number_id": "106540352242922" },
        "statuses": [{
          "id": "wamid...",
          "status": "delivered",
          "timestamp": "1750263773",
          "recipient_id": "16505551234",
          "conversation": { "id": "<conv_id>", "origin": { "type": "service" } },
          "pricing": { "billable": true, "pricing_model": "CBP", "category": "service" }
        }]
      }
    }]
  }]
}
```

Note both `messages` (incoming) and `statuses` (delivery lifecycle) arrive under the **same** `field: "messages"` webhook subscription — dispatch logic in `meta-webhook.controller.ts` needs to branch on whether `value.messages` or `value.statuses` is present, not on the `field` value alone.

`status` progression: `sent` → `delivered` → `read` (or `failed`). The `pricing` block tells you billing category (`marketing`/`utility`/`authentication`/`service`) and whether it's `billable` — useful for cost tracking/analytics.

## Gotchas

- Payloads can be up to **3 MB**.
- Dev-mode apps may not receive webhooks reliably — the app should be Live for production webhook delivery.
- Message delivery/webhook arrival order is not guaranteed; design idempotent, timestamp-ordered processing (dedupe on `wamid`/message id).
- Consider enabling mutual TLS for extra verification of the sender, in addition to payload signature checks (Meta signs webhook payloads with `X-Hub-Signature-256` — verify this header using your app secret on every request, this is separate from the initial `hub.verify_token` handshake).

## Sources

- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/history
- https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/manage-webhooks
