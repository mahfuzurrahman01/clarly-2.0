# Shopify Integration Reference

Vendor facts for `apps/api/src/modules/store/ports/shopify-store.provider.ts`, gathered 2026-10-03 from
shopify.dev (the `.md` form of each page, e.g. `https://shopify.dev/docs/api/usage/versioning.md`). Nothing
here has been run against a live Shopify store yet. Re-verify against https://shopify.dev before relying on
anything marked **UNVERIFIED**.

GraphQL reference pages were read at `/docs/api/admin-graphql/2026-10/...` (the page metadata calls this
version `latest`).

## Our Shopify app

- **No Shopify app exists yet.** No Dev Dashboard / Partner app has been created for Clarly, so there is
  no client ID, redirect URL or distribution method to record here.
- Distribution decides most of what follows, and it can't be changed after you pick it
  (https://shopify.dev/docs/apps/launch/distribution):
  - **Public distribution** (any number of stores): non-embedded apps use the authorization code grant.
    A public app created now (after 2026-04-01) must use **expiring** offline tokens. It needs
    **protected customer data review** before it can read customer phone numbers on real stores. If it is
    listed on the App Store, it must also meet App Store requirements: compliance webhooks,
    install only from a Shopify surface, and an embedded experience.
  - **Custom distribution** (one store, one Plus organization, or transfer-disabled dev stores): expiring
    tokens are not required, and protected customer data levels 1 and 2 are "Always available".
- Callback URL our code sends: `${API_PUBLIC_BASE_URL}/store/callback/shopify`. It must exactly match a
  redirect URL configured on the app (Dev Dashboard, or `redirect_urls` in `shopify.app.toml`).

## OAuth: authorization code grant (non-embedded apps)

Source: https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps
(also served at `.../access-tokens/authorization-code-grant`).

**Authorize:** `GET https://{shop}/admin/oauth/authorize`

| Param | Notes |
|---|---|
| `client_id` | App client ID |
| `scope` | Comma-separated scopes |
| `redirect_uri` | Must exactly match a configured redirect URL |
| `state` | Random nonce, verified on the callback |
| `grant_options[]=per-user` | Optional. Leave it out: we want an **offline** token |

- Scopes go in the URL only on the legacy install flow (`use_legacy_install_flow = true`, or an app
  without managed install). With Shopify managed installation, scopes come from `[access_scopes]` in
  `shopify.app.toml` (https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration).

**Callback:** `GET {redirect_uri}?code=...&hmac=...&shop=...&state=...&timestamp=...`

Before exchanging the code, the docs require three checks:

1. **`state`** must equal the nonce you issued. Our signed, single-use JWT state does this job.
2. **`hmac`**: take the query parameters without `hmac`, sort them by key, join them as
   `k1=v1&k2=v2`, and compute HMAC-SHA256 with the **client secret**. Compare it to `hmac` (hex) in
   constant time. The official sample:
   ```js
   const params = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'hmac'));
   const message = Object.entries(params).sort().map(([k, v]) => `${k}=${v}`).join('&');
   const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
   ```
   Every parameter Shopify sends counts, including any we don't use (e.g. `host`).
3. **`shop`** must match `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$`, anchored at both ends.

**Token exchange:** `POST https://{shop}/admin/oauth/access_token`,
`Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`.
Body: `client_id`, `client_secret`, `code`, `expiring=1`.

```json
{
  "access_token": "f85632530bf277ec9ac6f649fc327f17",
  "scope": "read_products,write_orders",
  "expires_in": 3600,
  "refresh_token": "shprt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "refresh_token_expires_in": 7776000
}
```

- The response has **no shop name**. Store id = the `shop` domain. A display name has to come from a
  GraphQL `shop { name }` query. *UNVERIFIED:* we haven't read the `Shop.name` field page.
- **Check the granted `scope`.** Merchants can change scopes during authorization. A `write_x` grant
  covers `read_x`.
- *UNVERIFIED:* whether a JSON body is accepted on the token endpoint. Every documented example is
  form-urlencoded.

### Expiring offline tokens (mandatory for new public apps)

Sources: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens,
https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens,
https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-public-apps-april-1-2026,
https://shopify.dev/changelog/expiring-offline-access-tokens-required-for-all-public-apps-as-of-january-1-2027

- **2026-04-01:** public apps created on or after this date must request and use expiring offline tokens.
- **2027-01-01:** this applies to all public apps. From then on, a GraphQL Admin API request with a
  non-expiring token returns **403** with the message
  `Non-expiring access tokens are no longer accepted for the Admin API`. Match on that phrase, because a
  missing scope also returns 403.
- **Not affected:** custom apps, and apps created by merchants.
- Lifetimes: access token **1 hour** (`expires_in: 3600`). Refresh token **90 days**
  (`refresh_token_expires_in: 7776000`); using it can shorten that. Read `expires_in` from the response
  rather than hard-coding it.
- `expiring` param: `1` = expiring, `0` (the default) = non-expiring.

**Refresh:** same endpoint, form-urlencoded:

```
client_id={client_id}&client_secret={client_secret}&grant_type=refresh_token&refresh_token={refresh_token}
```

```json
{
  "access_token": "shpat_yyyy...",
  "expires_in": 3600,
  "refresh_token": "shprt_zzzz...",
  "refresh_token_expires_in": 7776000,
  "scope": "write_products,read_orders"
}
```

- **Rotation:** every refresh returns a new access token and a new refresh token, and you must store both.
  The refresh token you presented stays usable until the earliest of:
  - you use the newer refresh token;
  - you get a new token through a code grant or token exchange;
  - 30 days after you first refreshed with it;
  - its original expiry.

  This is more forgiving than Salla, so a retried refresh isn't fatal.
- Shopify keeps **one current expiring offline token per app and store**. A new code grant retires the
  older tokens, which stay valid until their `expires_in` runs out.
- "Don't do the two at the same time for the same store": acquiring a token and refreshing one each
  retire the other's result.
- Errors:
  - `401 {"error":"invalid_request"}`: the refresh token is dead (expired, replaced, or the app was
    uninstalled). Clear the token pair and send the merchant back through OAuth.
  - 429, 5xx or a timeout: retry with the same refresh token.
  - Any other 4xx: permanent failure; don't retry.
- The sample refreshes about 60 s before expiry, and once more on a 401 from the Admin API.
- **Migrating a stored non-expiring token** without a user session:
  - Request: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
    `subject_token={old token}`,
    `subject_token_type=urn:shopify:params:oauth:token-type:offline-access-token`,
    `requested_token_type=urn:shopify:params:oauth:token-type:offline-access-token`, `expiring=1`.
  - The old token is permanently invalidated. A retry within 7 days returns the same token pair.

## Admin API version

Source: https://shopify.dev/docs/api/usage/versioning

| Version | Accessible until | Status (per doc, 2026-10-03) |
|---|---|---|
| 2025-10 | 2026-10-16 15:00 UTC | Unsupported |
| 2026-01 | 2027-01-16 | Stable |
| 2026-04 | 2027-04-16 | Stable |
| 2026-07 | 2027-07-16 | Stable |
| **2026-10** | **2027-10-16** | **Latest stable** |
| 2027-01 | 2028-01-16 | Release candidate |

- New versions come out quarterly. Each stable version is supported for at least 12 months.
- **Requests to an inaccessible version fall forward** to the oldest accessible stable version. The
  `X-Shopify-API-Version` response header shows which version actually served the request.
  - Our code pinned `2024-01` (long retired) until 2026-10-03, so it was silently served whatever the
    oldest accessible version was. It now pins `2026-10` (`SHOPIFY_ADMIN_API_VERSION`).
- Apps that keep using unsupported resources get delisted from the App Store.
- **Recommendation:** pin `2026-10` in one constant, and move it forward every quarter.
- Webhook payloads are versioned too:
  - app-specific (TOML) subscriptions use `[webhooks] api_version`;
  - shop-specific subscriptions use the version in the request URL that created them.

## Scopes

Sources: https://shopify.dev/docs/api/usage/access-scopes, the per-object "Requires" lines in the 2026-10
GraphQL reference, https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic

| Need | Scope | Evidence |
|---|---|---|
| `products`, `ProductVariant` (`price`, `sku`, `inventoryQuantity`) | `read_products` | ProductVariant: "Requires `read_products`" |
| `ProductVariant.inventoryItem { tracked }` | `read_products` **or** `read_inventory` | InventoryItem: "Requires `read_inventory` access scope or `read_products` access scope" |
| `inventory_levels/update` webhook | **`read_inventory`** | Topic enum: "Requires the `read_inventory` scope" |
| `products/update` webhook | `read_products` | Topic enum |
| `order`, `orders`, `orders/create` webhook | `read_orders` | Order: "Requires `read_orders` ..." |
| Orders older than 60 days | `read_all_orders` (**Shopify approval** via Partner Dashboard → API access requests) | "These scopes cover orders created within the last 60 days" |
| `Order.customer { ... }`, `customers(query:)` | **`read_customers`** | Customer: "Requires `read_customers` access scope" |
| `draftOrderCreate` | `write_draft_orders` | "Requires `write_draft_orders` access scope ... Also: The user must have access to manage draft orders" |
| `shop { currencyCode }` | none documented | *UNVERIFIED:* the `Shop` page lists no scope |

- Any `write_*` scope includes its `read_*`. We never write products, so `write_products` is
  unnecessary, and Shopify restricts scopes that apps don't need.
- **Recommended scope string:**
  `read_products,read_inventory,read_orders,read_customers,write_draft_orders`.
  - Add `read_all_orders` only after Shopify approves it.
  - Drop `read_inventory` if we stop subscribing to `inventory_levels/update`.

### Protected customer data (PCD)

Source: https://shopify.dev/docs/apps/launch/protected-customer-data

- **Level 1** covers customer data **excluding** name, address, phone and email. Orders, draft orders
  and fulfillments all count as customer data. **Level 2** adds those fields (phone, address).
- Reading `Order.phone`, `customer.defaultPhoneNumber` or `shippingAddress.phone`, and creating draft
  orders with a phone and address, all need **Level 2**.
- **Public app:** both levels require review:
  1. Partner Dashboard → API access requests → Protected customer data.
  2. Select the **Phone** and **Address** (and Name) fields.
  3. Fill in data protection details.
  4. Submit for review.
- **Custom app:** both levels are "Always available".
- **Development stores:** select the data and fields in the Partner Dashboard (up to step 5 there). No
  review is needed. You must have chosen a distribution method first, even for dev stores.
- **Unapproved access does not fail the request.** It returns HTTP **200** with the protected fields set
  to `null` and an `errors` entry such as
  `"This app is not approved to access the Customer object..."`. "GraphQL requests to unapproved types will
  return an HTTP `200 Ok` response with an error message in the `errors` hash."
  - So an unapproved app reads every order as phone-less, and our ownership re-check then drops every
    order.
- Webhooks that carry protected resources are redacted the same way. *UNVERIFIED:* whether subscribing
  to `orders/create` itself is refused without PCD approval.

## GraphQL Admin API (2026-10), fields we use

Endpoint: `POST https://{shop}/admin/api/2026-10/graphql.json`, header `X-Shopify-Access-Token`.

### Products: `products(first:, after:, query:)`
Sources: `.../2026-10/queries/products`, `/objects/Product`, `/objects/ProductVariant`, `/objects/InventoryItem`

| Field | Status |
|---|---|
| `Product.id`, `title`, `variants(first:)` | valid |
| `Product.images(first:)` | **Deprecated** (still served). Use `featuredMedia { preview { image { url } } }`. `Media.preview: MediaPreviewImage`, and `MediaPreviewImage.image` is null until the media is `READY` |
| `ProductVariant.id`, `sku` (nullable), `price` (`Money!`, a decimal string in **shop currency**) | valid |
| `ProductVariant.inventoryQuantity: Int` ("total sellable quantity") | valid |
| `ProductVariant.inventoryItem: InventoryItem!` → `tracked: Boolean!` | valid |
| `pageInfo { hasNextPage }`, edge `cursor` | valid |

- The `products` query accepts a `status` search filter. Use `query: "status:active"` to skip
  draft and archived products.

### Shop currency
`shop { currencyCode }`: `CurrencyCode!`, "The three letter code for the currency that the shop sells in."
Source: `.../2026-10/objects/Shop`.

### Order: `order(id:)` / `orders(first:, query:, sortKey:, reverse:)`
Sources: `.../2026-10/objects/Order`, `/queries/orders`, `/enums/OrderDisplayFulfillmentStatus`,
`/objects/Fulfillment`, `/objects/FulfillmentTrackingInfo`, `/objects/LineItem`, `/objects/Customer`

| Field | Status |
|---|---|
| `id`, `name` ("#1001"), `createdAt`, `cancelledAt` (null unless cancelled) | valid |
| `phone: String` | valid, PCD level 2 |
| `totalPriceSet { shopMoney { amount currencyCode } }` | valid |
| `customer` | valid, but **requires `read_customers`**. Null for guest checkout |
| `customer { phone }` | **Deprecated**. Use `customer { defaultPhoneNumber { phoneNumber } }` |
| `shippingAddress { phone }` | valid, PCD level 2. Null when no shipping is needed |
| `fulfillments(first:)` → `trackingInfo { number }` | valid |
| `lineItems(first:)` → `title`, `quantity`, `originalUnitPriceSet { shopMoney { amount } }` | valid |
| `sortKey: CREATED_AT` | valid `OrderSortKeys` value (the default is `PROCESSED_AT`) |

**`displayFulfillmentStatus` (all 11 values):**

- `FULFILLED`, `FULFILLMENT_NOT_REQUIRED`, `IN_PROGRESS`, `ON_HOLD`, `OPEN`, `PARTIALLY_FULFILLED`,
  `PENDING_FULFILLMENT`, `REQUEST_DECLINED`, `RESTOCKED`, `SCHEDULED`, `UNFULFILLED`.
- `OPEN` is "Replaced by UNFULFILLED", `PENDING_FULFILLMENT` by `IN_PROGRESS`, and `RESTOCKED` by
  `UNFULFILLED`. These are still enum values.
- `RESTOCKED` means "All the items in the order have been restocked". That is not a refund.

**Order search has no `phone` filter.** The documented `orders(query:)` filters on 2026-10 are:

- `cart_token`, `channel`, `channel_id`, `chargeback_status`, `checkout_token`, `confirmation_number`
- `created_at`, `credit_card_last4`, `current_total_price`, `customer_id`
- `delivery_method`, `discount_code`, `email`
- `financial_status`, `fraud_protection_level`, `fulfillment_location_id`, `fulfillment_status`
- `gateway`, `id`, `location_id`, `metafields.*`, `name`
- `payment_id`, `payment_provider_id`, `po_number`, `processed_at`
- `reference_location_id`, `requested_order_edit_status`, `return_status`, `risk_level`
- `sales_channel`, `sku`, `source_identifier`, `source_name`, `status`
- `subtotal_line_items_quantity`, `tag`, `tag_not`, `test`, `total_weight`, `updated_at`

What happens with an invalid field (https://shopify.dev/docs/api/usage/search-syntax): "If you specify an
invalid field, then the query is ignored and **all results are returned**". A warning
`"Invalid search field for this query."` shows up in `extensions.search`.

- `customers(query:)` **does** have a `phone` filter (example `phone:+18005550100`).
- So the documented path is
  `customers(first: 1, query: "phone:+E164") { nodes { orders(first: N, sortKey: CREATED_AT, reverse: true) { ... } } }`,
  which needs `read_customers` and `read_orders`.
- *UNVERIFIED:* whether guest-checkout orders that carry a phone always get a Customer record.

### Draft order: `draftOrderCreate(input: DraftOrderInput!)`
Sources: `.../2026-10/mutations/draftOrderCreate`, `/input-objects/DraftOrderInput`,
`/input-objects/DraftOrderLineItemInput`, `/input-objects/MailingAddressInput`, `/objects/DraftOrder`

- **`DraftOrderInput`:**
  - Fields we use or need: `lineItems` (at least 1, at most 499), `note`, `phone` ("The customer's phone
    number"), `email`, `shippingAddress`, `billingAddress`, `reserveInventoryUntil`, `tags`,
    `purchasingEntity`.
  - `customerId` is **deprecated**.
  - Draft orders do **not** reserve inventory by default.
- **`DraftOrderLineItemInput`:** `variantId` ("Must be null for custom line items, otherwise required") and
  `quantity`. A variant ID is required, and a product ID is not a valid substitute.
- **`MailingAddressInput`:** `address1`, `address2`, `city`, `countryCode`, `provinceCode`, `zip`,
  `firstName`, `lastName`, `company`, `phone`.
  - `phone` is "Formatted using E.164 standard".
  - `country`, `province` and `id` are deprecated.
  - *UNVERIFIED:* which address fields Shopify requires before it will calculate shipping or tax.
- **`DraftOrder`:** `id`, `invoiceUrl` ("The link to the checkout, which is sent to the customer in the
  invoice email"), `totalPriceSet` (includes tax, shipping and discounts), `status`.
- `userErrors { field message }` is always present.

## Webhooks

Sources: https://shopify.dev/docs/apps/build/webhooks/subscribe,
https://shopify.dev/docs/apps/build/webhooks/delivery-structure,
https://shopify.dev/docs/apps/build/webhooks/verify-deliveries, https://shopify.dev/docs/api/webhooks

### Subscribing

There are two ways to subscribe:

- **App-specific** (recommended): `[[webhooks.subscriptions]] topics = [...] uri = "https://..."` in
  `shopify.app.toml`, deployed with `shopify app deploy`. Or create a version in the Dev Dashboard.
  - One URI covers **every shop** that installs the app.
  - Failing subscriptions are not deleted.
  - This is the only way to subscribe to compliance topics.
- **Shop-specific**: the `webhookSubscriptionCreate(topic: WebhookSubscriptionTopic!, webhookSubscription:
  WebhookSubscriptionInput!)` mutation, called with that shop's token after install.
  - The destination field is **`uri`**. `callbackUrl` is **deprecated**.
  - Other input fields: `filter`, `includeFields`, `name`, `format`, `metafieldNamespaces`.
  - After 8 consecutive failures, an Admin API subscription is **deleted** automatically.
  - The URI can be per shop, so `/store/webhook/shopify/{shop}` works here.
- Topic enum values we need: `PRODUCTS_UPDATE`, `ORDERS_CREATE`, `INVENTORY_LEVELS_UPDATE`,
  `APP_UNINSTALLED`.

### Delivery

- `POST` with a JSON body. Respond with 2xx within **5 s**; the connection timeout is 1 s. A 3xx counts
  as a failure.
- Shopify retries 8 times over 4 hours.
- Headers (treat them as case-insensitive):

| Header | Meaning |
|---|---|
| `X-Shopify-Topic` | e.g. `products/update` |
| `X-Shopify-Hmac-Sha256` | base64 HMAC-SHA256 of the **raw body**, keyed with the app **client secret** |
| `X-Shopify-Shop-Domain` | the shop's `myshopify.com` domain |
| `X-Shopify-API-Version` | the version that serialized the payload |
| `X-Shopify-Webhook-Id` | **unique per delivery: the dedupe key** |
| `X-Shopify-Event-Id` | shared by every delivery from the same merchant action (correlation, not dedupe) |
| `X-Shopify-Triggered-At` | when the delivery was triggered |
| `X-Shopify-Name` | optional subscription name |

- After a client-secret rotation, deliveries can stay signed with the old secret for up to 1 hour.

### Payloads (REST resource shape, snake_case)

- `products/update`: `{ id, title, status, variants: [{ id, price, sku, inventory_item_id,
  inventory_quantity, old_inventory_quantity, ... }], images, image, ... }`.
  - Fires when "a product is updated, ordered, or variants are added, removed or updated".
  - *UNVERIFIED:* whether a stock-only change fires it.
- `inventory_levels/update`: `{ inventory_item_id, location_id, available, updated_at,
  admin_graphql_api_id }`.
  - `available` is for **one location**, not the variant total.
  - The payload has no product or variant id.
- `orders/create`: the full order resource, with `id`, `admin_graphql_api_id`, `name`, `phone`,
  `customer`, `shipping_address`, and so on.
- `app/uninstalled`: the shop resource (`id`, `name`, `domain`, `myshopify_domain`, `currency`, ...).

### Mandatory compliance webhooks

Source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance

- **Who needs them:** every app distributed through the Shopify App Store, whether or not it stores
  personal data. Without them the app is rejected at review. *UNVERIFIED:* what applies to custom
  distribution apps (the docs scope this to App Store apps).
- **Topics:** `customers/data_request`, `customers/redact`, `shop/redact`.
- **Configuration:** TOML or the Dev Dashboard only, never the Admin API:
  `[[webhooks.subscriptions]] compliance_topics = [...] uri = "..."`.
- **Required behavior:**
  - Accept a JSON `POST`.
  - Return **401** on an invalid HMAC.
  - Acknowledge with 2xx.
  - Complete the action within 30 days.
- **Payloads:**
  - `customers/data_request`: `{ shop_id, shop_domain, orders_requested, customer {id, email, phone},
    data_request {id} }`
  - `customers/redact`: `{ shop_id, shop_domain, customer {...}, orders_to_redact }`
  - `shop/redact`: `{ shop_id, shop_domain }`, sent 48 h after uninstall.

## Installs started from Shopify (App Store / install link / "Test on development store")

Sources: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements,
https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration,
https://shopify.dev/docs/apps/build/authentication-authorization

- **App Store requirement 2.3.1:**
  - "Apps must be installed and initiated only on Shopify services. Your app must not request the manual
    entry of a myshopify.com URL or a shop's domain during the installation or configuration flow."
  - 2.3.2 and 2.3.4: "immediately authenticate using OAuth before any other steps occur", on install and on
    reinstall.
  - 2.3.3: redirect to the app UI after the grant.
  - 2.2.2: "provide a consistent embedded experience".
  - Our "type your shop domain in the Clarly console" flow therefore **cannot be listed on the App
    Store**. It is fine for custom distribution.
- **Shopify managed installation** (`use_legacy_install_flow` omitted or `false`): "Shopify installs your
  app and updates its access scopes without calling your app." Scopes come from `[access_scopes]`. An app
  that isn't embedded doesn't receive ID tokens, so it still runs the code grant to get a token.
- **UNVERIFIED (not in the current docs):** the request Shopify sends to `application_url` when a
  merchant installs or opens a non-embedded app from Shopify's side.
  - An older, now-redirected Shopify page (seen only as a search snippet) said that request carries
    `shop`, `timestamp`, `hmac` (hex HMAC-SHA256 over the other params, same algorithm as the callback)
    and `host`.
  - It also said a never-embedded app should 3xx-redirect to `/admin/oauth/authorize`.
  - Either way, that request carries **no state of ours**. We would need an `application_url` handler
    that verifies `hmac` and works out the tenant itself, for example by having the merchant log in to
    Clarly first, before it starts OAuth.

## Gaps between this reference and our code (as of 2026-10-03)

Status column updated 2026-10-03 after the adapter alignment. "Fixed" means stubbed-fetch unit tests pass; **no live Shopify call has been made**. "n/a-custom" means out of scope while the app uses custom distribution (the first live test), and still open before public distribution. Line references in the "Our code does" column describe the code before the fix.

`provider.ts` = `apps/api/src/modules/store/ports/shopify-store.provider.ts`. The other files are in
`apps/api/src/modules/store/`.

| # | Area | Our code does | Shopify actually requires | Severity | Status |
|---|---|---|---|---|---|
| 1 | Token type | `exchangeCode` (provider.ts:225-251) never sends `expiring=1`. `refreshAccessToken` (258-261) returns `null` and the comment says offline tokens never expire | New public apps (created on or after 2026-04-01) must use expiring tokens: 1 h access, 90-day rotating refresh, `grant_type=refresh_token`. All public apps from 2027-01-01, after which non-expiring tokens get 403 | **Critical** (public distribution) | **n/a-custom** (open for public distribution; TODOS.md) |
| 2 | Refresh plumbing | `exchangeCode` returns no `refreshToken`/`expiresAt`. `StoreOAuthService.ensureAccessToken` (store-oauth.service.ts:129-156) never refreshes on a 401, and refreshes aren't serialized per connection | Store `refresh_token` and `expires_in`. Refresh about 60 s early and once on a 401. Store the rotated pair. Never refresh while also running a code grant for the same shop. A 401 `invalid_request` means re-authorize | **Critical** (with #1) | **n/a-custom** (open for public distribution; TODOS.md) |
| 3 | Callback HMAC | `StoreCallbackController.handleCallback` (store-callback.controller.ts:52-61) never reads `hmac` or `timestamp`, and nothing verifies them | Verify the hex HMAC-SHA256 over all sorted query params except `hmac`, keyed with the client secret, using a constant-time compare | **High** | **Fixed** 2026-10-03: `ShopifyStoreProvider.verifyCallbackSignature` via the `StoreProvider.verifyCallbackSignature` hook, run in `StoreOAuthService.handleCallback` before the exchange; the controller passes the full query; a bad hmac redirects to `/stores?error=oauth_failed`. `timestamp` freshness is not checked (the docs don't ask for it) |
| 4 | Shop binding | `shop` comes from the unauthenticated callback query (store-callback.controller.ts:97-99). `StoreOAuthStateService.sign` (store-oauth-state.service.ts:90-104) does not seal it the way it seals the WooCommerce `siteUrl` | The docs only demand the HMAC check plus the shop regex. Sealing `shop` into the state is defense in depth, matching our WooCommerce design | Medium | **Fixed** 2026-10-03: shop sealed into the signed state (`connectBinding`); callback `?shop=` cross-checked |
| 5 | API version | `graphql()` hard-codes `/admin/api/2024-01/` (provider.ts:449) | 2024-01 is retired, so requests fall forward to the oldest accessible version (2025-10, then 2026-01 after 2026-10-16). Pin `2026-10` in one constant | **High** | **Fixed** 2026-10-03: `SHOPIFY_ADMIN_API_VERSION = '2026-10'` |
| 6 | Scopes | `read_products,write_products,read_orders,write_draft_orders` (provider.ts:219) | No `write_products` (we never write products). Add `read_customers` (the `Order.customer` field) and `read_inventory` (the `inventory_levels/update` topic). `read_all_orders` (approval needed) for orders older than 60 days. The granted `scope` in the token response isn't checked (provider.ts:241-250) | **High** | **Fixed** 2026-10-03: `SHOPIFY_SCOPES` = the recommended string; a granted `scope` missing one logs a warning. `read_all_orders` still open (needs Shopify approval) |
| 7 | Phone search | `orders(query: "phone:\"...\"")` (provider.ts:425-435) | `orders` has **no `phone` filter**. An invalid field means "the query is ignored and all results are returned", so we get the shop's latest `ORDER_HISTORY_LIMIT` orders and the ownership re-check filters them down to almost nothing. Use `customers(query: "phone:+E164") { nodes { orders(...) } }` | **High** | **Fixed** 2026-10-03: `customers(first: 1, query: "phone:+E164") { nodes { orders(...) } }`. Guest orders without a Customer are not found (UNVERIFIED whether that happens) |
| 8 | Customer phone field | `customer { phone }` in `ORDER_FIELDS` (provider.ts:124), without the `read_customers` scope | `Customer` needs `read_customers`, and `Customer.phone` is deprecated. Use `customer { defaultPhoneNumber { phoneNumber } }` | **High** | **Fixed** 2026-10-03 |
| 9 | GraphQL errors | `graphql()` (provider.ts:459-460) returns `data` and drops `errors`. `readOrder` maps a null order to "not found" (412-413) | PCD and scope failures come back as **HTTP 200** with nulled fields plus `errors[]`. Surface `errors`, at least as a log, and treat redaction as an error rather than "no orders" | **High** | **Fixed** 2026-10-03: `graphql()` throws on any top-level `errors` entry; `StoreOrderLookupService.safely` logs it and the store contributes nothing |
| 10 | Protected customer data | No handling | Reading phone and address and writing draft-order phone and address need **Level 2** PCD. Public apps need review. Dev stores need the fields selected in the Partner Dashboard. Custom apps always have access | **High** (ops / config) | **Open** (ops/config). Custom distribution has Level 1+2 always; dev stores still need the fields selected in the Partner Dashboard |
| 11 | Status mapping | `shopifyOrderStatus` (provider.ts:137-155) maps `RESTOCKED` to `refunded` and has no case for `FULFILLMENT_NOT_REQUIRED`, `OPEN`, `PENDING_FULFILLMENT` or `REQUEST_DECLINED` (these fall to `unknown`) | 11 enum values. `RESTOCKED` = items restocked (not a refund). `OPEN` ≈ `UNFULFILLED`, `PENDING_FULFILLMENT` ≈ `IN_PROGRESS`, `FULFILLMENT_NOT_REQUIRED` ≈ completed | Medium | **Fixed** 2026-10-03: all 11 values mapped; `RESTOCKED`/`OPEN` → pending, `PENDING_FULFILLMENT` → processing, `FULFILLMENT_NOT_REQUIRED` → completed, `REQUEST_DECLINED` → on_hold |
| 12 | Currency | Products hard-code `currency: 'SAR'` (provider.ts:316). Orders and drafts fall back to `'SAR'` (172, 389) | `ProductVariant.price` is in the shop currency. Read `shop { currencyCode }` once per sync or connection | Medium | **Fixed** 2026-10-03: products read `shop { currencyCode }` in the same query as each page (no extra call). Orders/drafts read `shopMoney.currencyCode` (shop currency, non-null); the `'SAR'` fallback became `''` |
| 13 | Product image | `images(first: 1)` (provider.ts:280) | `Product.images` is deprecated. Use `featuredMedia { preview { image { url } } }` | Low | **Fixed** 2026-10-03 |
| 14 | Product status | `products(first: 50, after:)` with no filter (provider.ts:274) | Drafts and archived products are included. Add `query: "status:active"` | Low | **Fixed** 2026-10-03 |
| 15 | Draft line items | `variantId: gid://shopify/ProductVariant/${i.variantId ?? i.productId}` (provider.ts:368) | `variantId` is required and must be a variant ID. A product ID wrapped in a ProductVariant GID is wrong; fail instead of falling back | Medium | **Fixed** 2026-10-03: a line with no variant id throws before any call; `order-item-resolution.ts` snapshots `metadata.shopifyVariantId` from sync |
| 16 | Draft buyer data | The whole address goes into `shippingAddress.address1`, with the phone only on the address (provider.ts:361-366) | Set `DraftOrderInput.phone` as well. `MailingAddressInput.phone` must be E.164. *UNVERIFIED:* the address fields (`countryCode`, `city`) needed for shipping and tax | Medium | **Fixed** 2026-10-03: `DraftOrderInput.phone` and `shippingAddress.phone` as `+<digits>`, name split into `firstName`/`lastName`, free text in `address1`. No `countryCode`/`city` held (UNVERIFIED whether Shopify needs them for shipping/tax) |
| 17 | Token request format | JSON body (provider.ts:230-238) | Documented as `application/x-www-form-urlencoded` with `Accept: application/json`. *UNVERIFIED* whether JSON works | Medium | **Fixed** 2026-10-03 |
| 18 | Webhook registration | Nothing creates subscriptions anywhere in `apps/api/src`, so no Shopify webhook will ever arrive | Either TOML app-specific subscriptions (one URI for all shops) or `webhookSubscriptionCreate` per shop after install, with the `uri` field (not the deprecated `callbackUrl`). API subscriptions are deleted after 8 failures | **High** | **Fixed** 2026-10-03: `registerWebhooks` hook, called after the connection is written; topics already on the URI are skipped; failures are logged and never fail the connect |
| 19 | Webhook routing | The route is `POST /store/webhook/shopify/:storeId` (store-webhook.controller.ts:32). The connection is resolved from the path (store-webhook.service.ts:55-67) | TOML and compliance subscriptions use one URI for all shops. Route on the HMAC-verified `X-Shopify-Shop-Domain`; the HMAC proves the body and secret but does not cover the path | Medium | **Open** (not needed while subscriptions are shop-specific with a per-shop URI; needed for TOML subscriptions) |
| 20 | Stock webhook | `inventory_levels/update` maps `externalId` to `inventory_item_id` (provider.ts:518-527). `processEvent` calls `catalogService.updateStock(tenant, inventory_item_id, available)` (store-webhook.service.ts:166-185) | The catalog `externalId` is the **product** id (provider.ts:313), so this never matches. `available` is per location, not the variant total. Either re-read the variant by inventory item, or use `products/update` `variants[].inventory_quantity` | **High** | **Fixed** 2026-10-03: `inventory_levels/update` → `inventory_changed` → background re-sync of the connection (one in flight per connection per process) |
| 21 | Uninstall | `app/uninstalled` falls through to `unknown` (provider.ts:529) | Subscribe to it and mark the connection disconnected. After uninstall, tokens return 401 | Medium | **Fixed** 2026-10-03: `app/uninstalled` → `markDisconnected` |
| 22 | Compliance webhooks | None | `customers/data_request`, `customers/redact` and `shop/redact` are required for App Store apps. Configure them in TOML or the Dev Dashboard only. Return 401 on a bad HMAC and 2xx otherwise; act within 30 days | **High** (App Store) | **n/a-custom** (open for App Store; TODOS.md) |
| 23 | Install from Shopify | The only entry point is `POST /store/connect/shopify?shop=` from our console (store.controller.ts:63-88) | App Store 2.3.1 forbids asking for the shop domain, and 2.3.2 requires OAuth right after an install started from Shopify. That needs an `application_url` handler that verifies `hmac` and resolves the tenant without our state. *UNVERIFIED:* the exact request shape. Not needed for custom distribution | **High** (App Store) / n/a (custom) | **n/a-custom** (open for App Store; TODOS.md) |
| 24 | Dedupe id | `extractEventId` reads `x-shopify-webhook-id` (provider.ts:484-490) | Correct: `X-Shopify-Webhook-Id` is the per-delivery dedupe key | OK | OK |
| 25 | Webhook HMAC | base64 HMAC-SHA256 over the raw body with the client secret (provider.ts:468-482) | Correct | OK | OK |
