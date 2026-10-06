# Salla Integration Reference

Vendor facts for `apps/api/src/modules/store/ports/salla-store.provider.ts`, gathered 2026-10-01 from Salla's
docs and official libraries, plus what we observed against the live Salla app. Re-verify against
https://docs.salla.dev before relying on anything marked *unverified*.

## Our Salla app (Partners portal)

- Portal: https://portal.salla.partners → Apps → **Clarly**
- Type: Public app, **General App**, category **AI**
- Client ID: `11a4fadd-59c8-46f7-a7a5-353f36616eb2` (secret lives in `SALLA_CLIENT_SECRET`, never in git;
  it was pasted into a chat session on 2026-10-01: rotate it before production)
- OAuth mode: **Custom Mode** (our code only implements the authorization-code redirect).
  Easy Mode delivers tokens via the `app.store.authorize` webhook instead; we have no handler for it.
- Callback URL: `https://clarly-api.onrender.com/store/callback/salla` (`SALLA_REDIRECT_URI`, defaults to
  `${API_PUBLIC_BASE_URL}/store/callback/salla`)
- App Scope (set in the portal, NOT in the authorize URL): Basic Information read,
  Products read+write, Orders read+write, Customers read+write.

## OAuth 2.0 (Custom Mode)

Source: https://docs.salla.dev/421118m0, https://github.com/SallaApp/oauth2-merchant

**Authorize:** `GET https://accounts.salla.sa/oauth2/auth`
`client_id`, `response_type=code`, `redirect_uri`, `scope`, `state`.

- `scope` must be **`offline_access`** (required to get a refresh token). Permissions come from the
  portal App Scope screen. Sending anything else fails. Observed live 2026-10-01:
  `error=invalid_scope ... The OAuth 2.0 Client is not allowed to request scope 'read_products'`.
- Errors come back to the callback as `?error=...&error_description=...&state=...` with NO `code`.
- Success callback: `?code=...&scope=<app-scopes>+offline_access&state=...`

**Token:** `POST https://accounts.salla.sa/oauth2/token`, `application/x-www-form-urlencoded`
`client_id`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`.

```json
{
  "access_token": "ory_at_...",
  "expires": 1209599,
  "refresh_token": "ory_rt_...",
  "scope": "settings.read customers.read_write orders.read_write ...",
  "token_type": "bearer"
}
```

- `expires` is a lifetime in seconds (~14 days). Docs show `expires`, not `expires_in`.
- The response has **no store id / name / url**; fetch them from user info (below).

**Refresh:** same URL, `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`.

- Access token lives 14 days; refresh token lives 1 month.
- Refresh tokens are **single-use and rotate**. Store the new one every time.
- Parallel or repeated refreshes with the same refresh token revoke **all** tokens issued from it.
  Refresh must be serialized per connection.

**User / merchant info:** `GET https://accounts.salla.sa/oauth2/user/info`, `Authorization: Bearer <access>`

```json
{
  "status": 200,
  "success": true,
  "data": {
    "id": 1771165749,
    "name": "Test User",
    "email": "testuser@email.partners",
    "mobile": "+966500000000",
    "role": "user",
    "merchant": {
      "id": 1803665367,
      "username": "dev-j8gtzhp59w3irgsw",
      "name": "dev-j8gtzhp59w3irgsw",
      "domain": "https://salla.sa/YOUR-DOMAIN-NAME",
      "status": "active",
      "plan": "special"
    }
  }
}
```

Store id = `data.merchant.id`, name = `data.merchant.name`, url = `data.merchant.domain`
(the envelope is confirmed by SallaApp/passport-strategy and SocialiteProviders, which both read `json.data`).

## Merchant API

**Base URL: `https://api.salla.dev/admin/v2`** (NOT `https://api.salla.dev/v2`).
Auth: `Authorization: Bearer <access_token>`.

### List products: `GET /products`
Source: https://docs.salla.dev/5394168e0
Query: `page`, `per_page`, `keyword` (name/SKU), `status` (`hidden|sale|out`), `category`, `format=light`.

```json
{
  "status": 200,
  "success": true,
  "data": [{
    "id": 123456789,
    "name": "Product Name",
    "sku": "SKU-12345",
    "price": { "amount": 99.99, "currency": "SAR" },
    "quantity": 50,
    "status": "sale",
    "images": [{ "id": 1, "url": "https://...", "main": true, "alt": "...", "type": "image" }],
    "categories": [{ "id": 1, "name": "Category Name" }]
  }],
  "pagination": { "count": 20, "current": 1, "next": "https://...?page=2" }
}
```

- `price` is an object, `quantity` (not `stock`), `images[].url` (objects, not strings), `categories[]`
  (array, not `category`).
- *Unverified:* the pagination shape. The doc summary showed `pagination.{count,current,next}`; Salla's v2
  APIs commonly return `pagination.{currentPage,totalPages,links.next}`. Parse both.
- *Unverified:* `quantity` may be `null` for unlimited-stock products.

### Create order: `POST /orders`
Source: https://docs.salla.dev/5394145e0

Required:
- **customer**: `customer.id`, OR `customer.name` + `customer.mobile` + `customer.email` (all three).
  Alternatively a `receiver` object (`name`, `country_code`, `phone`, `email`, `notify`).
- **payment**: `status` = `paid` | `pending_payment`.
  `paid` → `method` (`credit_card|mada|bank|cod|subscription`); `pending_payment` → `accepted_methods`.
- **products[]**: `identifier_type` (`id|sku`), `identifier`, `quantity`.
- **delivery** (if shippable): `delivery_method` = `pickup` (+ `branch_id`) | `shipping` (+ `courier_id`,
  `ship_to.{country, city, district, block, street_number, address, address_line, postal_code, geo_coordinates}`).

```json
{
  "customer": { "id": 1994632541 },
  "payment": { "status": "pending_payment", "accepted_methods": "cod" },
  "products": [{ "identifier_type": "id", "identifier": "123", "quantity": 1 }],
  "delivery_method": "pickup",
  "branch_id": 456
}
```

Response (201):
```json
{
  "status": 201, "success": true,
  "data": {
    "id": 1107722485,
    "checkout_id": "3058806946742845435",
    "urls": { "customer": "https://.../account/orders/XArYbdA", "admin": "https://s.salla.sa/orders/order/..." },
    "amounts": { "total": { "amount": 230, "currency": "SAR" } },
    "payment_method": "cod"
  }
}
```

The customer-facing link is `data.urls.customer`, and the total is `data.amounts.total.amount`.

### Orders read
- `GET /orders/{id}`, `GET /orders` (paging + status filters). *Unverified:* whether any filter matches
  by customer phone; we use `search` and re-check every order's phone server-side.

## Webhooks

Source: https://docs.salla.dev/421119m0, https://docs.salla.dev/security

- Configured **per app** in the Partners portal (App → Webhooks/Notifications): one URL and one secret
  for every merchant that installs the app.
- Headers: `X-Salla-Security-Strategy` (`Signature` default | `Token`), `X-Salla-Signature`, `Authorization`.
- Signature strategy: hex HMAC-SHA256 of the raw body, keyed with the app's webhook secret.
- Envelope: `{ event, merchant, created_at, data }`. `merchant` is the store id.
- Events we care about: `order.created`, `product.updated`, `product.quantity.low`;
  app events: `app.store.authorize` (Easy Mode tokens), `app.installed`, `app.uninstalled`, `app.settings.updated`.

## Gaps between this reference and our code (as of 2026-10-01)

| # | Gap | Where | Status |
|---|---|---|---|
| 1 | Authorize `scope` must be `offline_access` | `salla-store.provider.ts` `getOAuthAuthorizeUrl` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla) |
| 2 | Token response has no store fields; call `/oauth2/user/info` → `data.merchant` | `exchangeCode` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla) |
| 3 | Expiry is `expires`, not `expires_in` | `expiryFrom` / `OAuthTokenResponse` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla); `expiryFrom` reads `expires_in ?? expires` |
| 4 | Base URL must be `https://api.salla.dev/admin/v2` | `baseUrl` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla) |
| 5 | Product mapping: `price.amount`, `quantity`, `images[].url`, `categories[0].name`, pagination | `listProducts` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla); null `quantity` = in stock, `stock: null` (untracked, orderable) since the nullable-stock change |
| 6 | Create order body is wrong (`items`/`shipping.address`); needs `products[]` with `identifier_type`, a customer (name+mobile+email or id), `payment`, delivery. Response: `data.urls.customer`, `data.amounts.total` | `createOrder` | Fixed 2026-10-01 (stubbed-fetch tests only, not yet run against live Salla); no email is held, so the buyer goes in `receiver` (or `customer.id`); `ship_to` carries only `address`, no `courier_id` |
| 7 | Webhooks are per-app with an app-level secret; our route is per-store with a per-connection secret. Key off the payload's `merchant` instead | `store-webhook.*`, `resolveWebhookSecret` | Open (needs design) |
| 8 | Concurrent refreshes revoke all tokens; refresh must be serialized per connection | `StoreOAuthService.ensureAccessToken` | Open (needs design) |
| 9 | Provider `?error=` callbacks (no `code`) return a bare 400 instead of redirecting to `/stores?error=` | `store-callback.controller.ts` | Fixed 2026-10-01 (controller unit test; redirects to `/stores?error=oauth_failed`) |
