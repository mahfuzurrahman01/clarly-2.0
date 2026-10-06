# Zid Integration Reference

Vendor facts for `apps/api/src/modules/store/ports/zid-store.provider.ts`, gathered 2026-10-03 from
https://docs.zid.sa (the `.md` form of each page, indexed at `https://docs.zid.sa/llms.txt`) and Zid's
official sample app https://github.com/zidsa/express-sample-app. Nothing here has been run against a live
Zid store yet. Re-verify against https://docs.zid.sa before relying on anything marked **UNVERIFIED**.

## Our Zid app (Partner Dashboard)

- **No Zid app exists yet.** `ZID_CLIENT_ID` / `ZID_CLIENT_SECRET` in `apps/api/.env` are placeholder
  strings, not real credentials.
- Portal: https://partner.zid.sa → **My Apps** (https://partner.zid.sa/applications) → **Create Application**
  → Private or Public application.
- Callback URL our code sends: `${API_PUBLIC_BASE_URL}/store/callback/zid` (`ZID_REDIRECT_URI` overrides
  it). It must match the **Callback URL** registered on the app.
- Scopes are picked on the app page in the Partner Dashboard (**App Scopes**, each with a written
  justification for Zid's review team), not in the authorize URL.

### Getting the client ID and secret

Source: https://docs.zid.sa/create-first-app.md, https://docs.zid.sa/authorization.md

1. Register a partner account at https://partner.zid.sa.
2. **My Apps** → **Create Application** → choose **Private** or **Public**. Fill in name (AR + EN),
   categories (max 3), language, maintainer email. Saving creates a draft app.
3. The App Details page shows **App Keys**: OAuth 2.0 end-point, **Client ID**, **Client Secret**.
4. **App Scopes**: select what we need (below) and justify each one.
5. **App links**:
   - Application URL: our console, e.g. `https://<console>/settings/store`
   - Redirection URL: where Zid sends the merchant after install. It must start OAuth, so point it at the
     page that calls our connect endpoint.
   - Callback URL: `https://clarly-api.onrender.com/store/callback/zid` (prod) or the ngrok URL for local.
6. **Install on Development Stores**: create a dev store from the dashboard and install the draft app on it
   for live testing. A public listing needs review; a dev store does not.
7. Put the values in `apps/api/.env` (and on Render): `ZID_CLIENT_ID`, `ZID_CLIENT_SECRET`, `ZID_APP_ID`
   (the App ID, used as the webhook `original_id`; without it no webhooks are subscribed), plus
   `ZID_REDIRECT_URI` only if the registered callback differs from the derived one.

Scopes we need, by the endpoints in the adapter:

| Scope | Why |
|---|---|
| `products.read` | Catalog sync (`GET /v1/products/`) |
| `orders.read` | `GET /v1/managers/store/orders`, order view |
| `third_create_order` / `order_create` (docs use both names) | Draft order creation |
| `third_webhook_read`, `third_webhook_write` | List / create webhook subscriptions |

## OAuth 2.0 (authorization code)

Source: https://docs.zid.sa/authorization.md, https://docs.zid.sa/zid-app-activation-oauth-policy-2422816m0.md

- OAuth server: `https://oauth.zid.sa`. API base: `https://api.zid.sa/v1`.

**Authorize:** `GET https://oauth.zid.sa/oauth/authorize`
`client_id`, `redirect_uri`, `response_type=code`. The docs' example sends no `scope` (scopes come from the
dashboard). The activation policy requires a random, one-time, short-lived `state` that we validate on
the callback, and PKCE "where supported" (no PKCE parameters are documented).

**Token:** `POST https://oauth.zid.sa/oauth/token`, parameters in the **body**:
`grant_type=authorization_code`, `client_id`, `client_secret`, `redirect_uri`, `code`.

Response fields (per the docs and the sample app's `callback.ts`):

| Field | Use |
|---|---|
| `access_token` | The **manager token**. Sent as `X-Manager-Token` (and as `Access-Token` on product endpoints) |
| `authorization` | The **partner authorization token**. Sent as `Authorization: Bearer <authorization>` |
| `refresh_token` | Refresh |
| `expires_in` | Lifetime; docs say 1 year |

- **Two tokens, both required on every call.** The sample app:
  ```ts
  const managerToken = merchantTokens.access_token;
  const authToken = merchantTokens.authorization;
  headers: { Authorization: `Bearer ${authToken}`, 'X-Manager-Token': managerToken }
  ```
- The token response has **no store id / name / url**. Get them from
  `GET /v1/managers/account/profile` (below).

**Refresh:** same URL, `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`,
`redirect_uri`. Manager token and refresh token both expire after 1 year; docs say refresh "10 months or
so" in. Whether the refresh response rotates `refresh_token` and `authorization` is **UNVERIFIED**; store
whatever comes back.

**Uninstall:** "When the merchant uninstall your app, we will send you a webhook with this event and the
tokens you have will be invalid" (`app.market.application.uninstall`, below).

### Activation policy (applies to App Market apps, updated 2026-09-09)

- Standard apps must start OAuth **immediately** when the merchant clicks **Activate** in Zid. No signup or
  login gate before OAuth, no generic homepage. Account linking happens after the callback.
- "Connect Zid" from an existing partner account (our `/settings/store` flow) is allowed as a secondary
  entry, as long as the Zid-started activation also works.
- Never ask the merchant to paste tokens, API keys or a store ID.
- Never log authorization codes or tokens; strip the code before onward navigation.
- Reauthorize / reinstall must not create duplicate connections. Uninstall must stop processing.

## Merchant API

Common headers (from every endpoint spec):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <authorization>` from the token response |
| `X-Manager-Token` | `<access_token>` from the token response |
| `Accept-Language` | `en` or `ar` (optional) |

**Product endpoints use different headers:** `Access-Token: <access_token>`, `Store-Id: <store id>`,
`Role: Manager`, `Accept-Language`. The docs say all calls also need `Authorization`; sending it on product
calls too is the safe reading (**UNVERIFIED**).

**Rate limit:** 60 requests / minute per app per store (leaky bucket). Zid says to use webhooks instead of
polling for order/payment status.

### Store identity: `GET /v1/managers/account/profile`

Response (trimmed): `{ "user": { ..., "store": { "id": 3, "uuid": "...", "title": "متجر أسامة.",
"url": "https://osama.zid.store/", "currency": { "code": "SAR" }, "language": { "code": "ar" }, ... } } }`

- `user.store.id` is the numeric id webhook and product calls use (`Store-Id`, `store_id` in payloads).
- `user.store.title` → store name, `user.store.url` → store URL, `user.store.currency.code` → currency.

### List products: `GET /v1/products/`

Query: `page`, `page_size` (default 10), `search`, `is_published`, `in_stock`, `id__in`, `extended`, ...

```json
{
  "count": 175,
  "next": "http://api.zid.sa/v1/products/?page=2...",
  "previous": null,
  "results": [{
    "id": "a1477bb2-72ea-4be9-b2cf-093cefc721bb",
    "sku": "Z.177...", "parent_id": null, "structure": "standalone",
    "name": { "ar": "قسيمة", "en": "voucher" },
    "price": 100, "sale_price": null, "currency": "SAR",
    "quantity": 4, "is_infinite": false, "is_draft": false,
    "images": [{ "image": { "thumbnail": "...", "small": "...", "medium": "...", "large": "...", "full_size": "..." } }],
    "categories": [{ "id": "1473476", "name": { "en": "Electronics", "ar": "إلكترونيات" } }],
    "html_url": "https://osama.zid.store/products/...", "store_id": 3
  }]
}
```

- Product ids are **UUID strings**. `name` and category `name` are `{ ar, en }` objects (managers always
  get both languages).
- Pagination is Django-style: `count` / `next` / `previous` / `results`. More pages exist when `next` is
  not null. There is no `data` / `meta.last_page`.
- Stock: `quantity` + `is_infinite`. Per-location stock: `GET /v1/products/{id}/stocks/`.
- `structure` marks parent / child (variant) products.

### Orders

**List:** `GET /v1/managers/store/orders`, scope `orders.read`

- Query: `page` (required), `per_page` (required, max 100), `search_term` (phone, email, order code or
  customer name, e.g. `966500000005`), `order_status`, `payment_status`, `customer_id`, `date_from`,
  `date_to`, `payload_type` (`simple` default without products; `default` includes products).
- Response: `{ "orders": [...], "total_order_count": N, ... }`.
- Marketplace orders (`is_marketplace_order: true`) have masked customer name / email / phone, and phone
  may be `null`.

**View:** `GET /v1/managers/store/orders/{order-id}/view`

```json
{
  "order": {
    "id": 68340124, "code": "rEXuB20myr", "store_id": 3,
    "order_status": { "name": "New", "code": "new" },
    "currency_code": "EGP",
    "customer": { "id": 31504, "name": "test user", "email": "test@gmail.com", "mobile": "966333333333" },
    "order_total": "6954.63998402370000",
    "payment_status": "pending",
    "created_at": "2026-04-21 15:12:07",
    "payment_link": null,
    "order_url": "https://osama.zid.store/o/rEXuB20myr/inv"
  }
}
```

- Order status codes: `new`, `preparing`, `ready`, `indelivery` (webhook conditions spell it
  `inDelivery`), `delivered`, `cancelled`, plus merchant custom sub-statuses.
- `order_total` is a decimal **string**. Currency can differ from the store currency.

### Create order: `POST /v1/managers/store/drafts`

Scope `third_create_order`. Creates an **order draft** on the merchant's behalf.

- Body includes `currency_code`, `coupon_code`, `customer { full_name, mobile_country_code (no +),
  mobile_number, email }` (all four required), `consignee { contact, address ... }`, products,
  `payment_method { id, payment_link_configs? }`, shipping method.
- For a ZidPay payment link: list payment methods, take the id of the one with
  `code: "payment_link.zidpay"`, send it as `payment_method.id` with
  `payment_link_configs.expiryDateTime`.
- `POST /v1/managers/store/drafts/validate` exists to validate a request first
  (https://docs.zid.sa/validate-order-request-36477334e0.md).
- Full schema: https://docs.zid.sa/create-order-20612055e0.md (≈120 KB; read it before implementing).

## Webhooks

Source: https://docs.zid.sa/webhooks.md, https://docs.zid.sa/create-a-webhook.md,
https://docs.zid.sa/events-878234m0.md

### Store events: subscribed by API, per store

`POST /v1/managers/webhooks` (scope `third_webhook_write`) with the store's tokens:

```json
{
  "event": "order.create",
  "target_url": "https://clarly-api.onrender.com/store/webhook/zid/<storeId>",
  "original_id": "<our Zid App ID>",
  "conditions": { "status": "new" },
  "username": "<basic-auth user>",
  "password": "<basic-auth password>"
}
```

- `GET /v1/managers/webhooks` lists our subscriptions; delete by `original_id` or by subscriber.
- `original_id` is **not** a free-form id. The Delete Webhook page
  (https://docs.zid.sa/delete-a-webhook-by-original-id.md) says it "Must be either: the App ID assigned to
  your integration, OR the MD5 hash of the App ID". We send the App ID from `ZID_APP_ID`.
  `DELETE /v1/managers/webhooks?original_id=<app id>` removes this app's subscriptions; that it is scoped
  to the store of the `X-Manager-Token` is **UNVERIFIED**.
- `conditions` is optional (nullable, not in `required`); we send none.
- **Authentication is HTTP Basic, not an HMAC signature.** If `username`/`password` are set, Zid sends
  `Authorization: Basic base64(username:password)` on each delivery. No body signature is documented.
- Events:
  - Orders: `order.create`, `order.status.update` (both support `conditions`),
    `order.payment_status.update`
  - Products: `product.create`, `product.update`, `product.publish`, `product.delete`
  - Abandoned carts: `abandoned_cart.created`, `abandoned_cart.completed`
  - Customers: `customer.create`, `customer.update`, `customer.merchant.update`, `customer.login`
  - Categories: `category.create`, `category.update`, `category.delete`
- There is **no stock-change event**. Stock moves arrive (if at all) as `product.update`.
- Payload schemas are referenced (DataSchema ids 2771504 order, 2771485 product) but not inlined in the
  `.md` pages. Envelope fields (event name, store id) are **UNVERIFIED**; capture a real delivery.
- Health APIs exist for broken / degraded subscriptions (Health Summary, Broken Webhooks, Recover).

### App events: configured in the Partner Dashboard

Set in the app's **Webhooks** section (endpoint, events, optional custom auth headers). Payload example:

```json
{
  "app_id": 1292, "store_id": 507530, "store_uuid": "d78468cd-...", "store_url": "https://wyatt.com.sa/",
  "event_name": "app.market.application.install", "status": "install",
  "plan_name": "...", "plan_type": "Paid", "start_date": "...", "end_date": "...",
  "merchant_email": "...", "merchant_phone_no": "966554349999"
}
```

Events: `app.market.application.authorized`, `.install`, `.uninstall`, `.rated`,
`app.market.subscription.active` / `.warning` / `.suspended` / `.expired` / `.renew` / `.upgrade` /
`.refunded`, `app.market.private.plan.request`.

## Gaps between this reference and our code

Listed 2026-10-03 against the first-cut adapter. Status after the alignment the same day (HANDOFF entry
"Store — Zid adapter aligned with docs.zid.sa"). "Fixed" means the code now matches these docs and is
covered by stubbed-fetch tests. **Nothing has been run against a live Zid store**; there is no Zid app or
credentials yet.

| # | Gap | Status |
|---|---|---|
| 1 | Auth headers | **Fixed.** `Authorization: Bearer <authorization>` + `X-Manager-Token: <access_token>` on every Merchant API call. |
| 2 | Second token dropped | **Fixed.** `authorization` (or `Authorization`) is required from the token exchange and stored AES-256-GCM encrypted in the new `store_connections.authorization_token` column (migration `0066_store-authorization-token.sql`, applied to Supabase project `wrluzyijfnxwrcrtvzrd` via the Supabase MCP on 2026-10-03). Refresh keeps a returned one. Connections made before 0066 have none and must reconnect: the adapter throws "reconnect the store" without calling Zid. |
| 3 | Store identity | **Fixed.** `GET /v1/managers/account/profile` → `user.store.{id,title,url}`. A missing `id` fails the connect. |
| 4 | Authorize URL `scope` | **Fixed.** Dropped; `state` kept. |
| 5 | Products | **Fixed.** `GET /v1/products/?page=&page_size=50&is_published=true`, product headers (`Authorization`, `Access-Token`, `Store-Id`, `Role: Manager`, `Accept-Language: en`), `results`/`next`, `{ar,en}` names, `images[].image.*`, `categories[0].name`, payload `currency`, UUID ids. |
| 6 | Orders read | **Fixed.** Zid has its own reader in `zid-store.provider.ts` (the shared `rest-order-reader` is untouched): `/managers/store/orders/{id}/view` → `{order}`, `/managers/store/orders?search_term=&page=1&per_page=20&payload_type=default&order_by=created_at&sort_by=desc` → `{orders}`. Status codes mapped (`new`→pending; `preparing`/`ready`/`indelivery`→processing; `delivered`→completed; `cancelled`→cancelled; anything else→unknown). `order_total` parsed from its decimal string. |
| 7 | Create order | **Open (deliberately refused).** `POST /v1/managers/store/drafts` requires `shipping_method {type, id}`, a structured `consignee.address` (`line_1`, `line_2`, `city_name`, ISO `country_code`), `customer.email`, products by `sku`, and a ZidPay `payment_method.id`. Our order has a free-text address, no email and no shipping method, so `createOrder` throws `ZidOrderInputError` before any call rather than invent them. The push fails and the merchant is told to enter the order by hand. Unblock gate in `TODOS.md`. |
| 8 | Webhook auth | **Fixed.** HTTP Basic: the inbound `Authorization` header is compared in constant time with `Basic base64("clarly:<connection webhook secret>")`. The HMAC `x-zid-signature` check is gone. `POST /store/connections/:id/webhook-secret` now refuses Zid connections (rotating would break the subscriptions). |
| 9 | Webhook subscription | **Fixed, needs `ZID_APP_ID`.** After connect: `DELETE /v1/managers/webhooks?original_id=<app id>` (clears subscriptions with an old password), then `POST /v1/managers/webhooks` for `order.create`, `order.status.update`, `product.create`, `product.update`, `product.delete` to `${API_PUBLIC_BASE_URL}/store/webhook/zid/<store id>` with `original_id`, `username`, `password`. Any failure (including `ZID_APP_ID` unset) is logged, keeps the connection, and adds `&webhooks=failed` to the callback redirect. |
| 10 | Event names | **Fixed.** `order.create`→`order_created`; `order.status.update` / `order.payment_status.update`→`order_updated` (new event type, recorded only); `product.create/update/publish/delete`→`product_updated` (recorded; next sync sweep picks it up). No stock event. Event id = `<event>:<resource id>:<updated_at>`, else a body hash. Envelope still **UNVERIFIED**: the name is read from `event` or `event_name`, the resource from `data` or the top level; no name → ignored. |
| 11 | Uninstall | **Open.** `app.market.application.uninstall` normalizes to `app_uninstalled` (which disconnects), but App Market events go to the single endpoint set in the Partner Dashboard, not our per-store route, and their auth is custom headers set there. That needs its own route and an app-level secret. Tracked in `TODOS.md`. |
| 12 | Rate limit | **Partly fixed.** A 429 is retried up to 3 times after `Retry-After` (if sent; **UNVERIFIED**) or 2 s / 4 s / 8 s, capped at 30 s. Pages are 50 products. There is no proactive per-store limiter, so a sync of a large store plus concurrent order lookups can still hit the limit and back off. |

### UNVERIFIED assumptions in the aligned code

- Partner token key in the token response: `authorization` (sample app) or `Authorization` (docs prose); both read.
- Whether refresh rotates `refresh_token` / `authorization`: whatever comes back is stored.
- `Authorization` header on product endpoints (docs list only `Access-Token`/`Store-Id`/`Role`; the general
  rule says every call needs it).
- `page_size=50` is accepted (default 10, no documented maximum).
- `price` is used as the product price; a non-null `sale_price` is kept in metadata only, because the sale
  window (`purchase_restrictions.sale_price_period_*`) is not evaluated.
- Order `created_at` (`'2026-04-21 15:12:07'`, no zone) is read as UTC. Inferred from the View Order example,
  whose `issue_date` (`06:12 م`, Riyadh) is 3 hours later.
- `orderNumber` is the numeric order id (`invoice_number` equals `id` in the docs); the alphanumeric `code`
  is not used.
- View Order not-found status: 404 → null; other non-2xx throws. A reference that is not all digits is
  answered null without a call.
- `search_term` with the phone's digits (`966…`, no `+`) finds the customer's orders.
- `Retry-After` on 429.
- Webhook delivery envelope (event name field, resource location, `updated_at` presence).
- `DELETE /v1/managers/webhooks?original_id=` is store-scoped.
- Create Order `customer.email`: required in Create Order, nullable in Validate Order.
