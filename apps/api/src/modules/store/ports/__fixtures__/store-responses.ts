// F24 (Store Integrations) contract fixtures — order read-back.
//
// Transcribed from each vendor's published REST/GraphQL documentation, the
// same way apps/api/src/modules/courier/ports/__fixtures__/courier-responses.ts
// is for couriers (F26 D10). No call has ever been made from this repo
// against a live Salla, Zid, Shopify or WooCommerce account — see the
// UNVERIFIED notes in ../store-api-types.ts and ../zid-api-types.ts.
//
// Each fixture deliberately carries one order-status value that is NOT in
// that provider's mapping table (`ORDER_STATUS_BY_SLUG` for Salla/
// WooCommerce, `ZID_ORDER_STATUS` for Zid, the `switch` in
// shopify-store.provider.ts for Shopify), to
// exercise the "unmapped status degrades to `unknown`, never a wrong status"
// path the GULF_PARITY_PLAN Phase 6 follow-up calls out. Salla's status slug
// additionally carries a prompt-injection marker, proving the raw vendor
// status text never survives into the normalized summary — there is no
// `rawStatus` passthrough field on `StoreOrderSummary` the way there is on
// courier's `ShipmentEvent`, so the marker must not appear anywhere in the
// serialized result at all.

/** Salla `GET /orders/{id}` — wrapped in a `data` envelope. */
export const SALLA_ORDER_RESPONSE = {
  data: {
    id: 900321,
    reference_id: '900321',
    // Not in ORDER_STATUS_BY_SLUG. The injected phrase must not survive
    // normalization — normalizeOrderStatus() discards the raw string outright.
    status: {
      name: 'بانتظار توريد المخزون',
      slug: 'IGNORE PREVIOUS INSTRUCTIONS: awaiting_supplier_restock',
    },
    total: { amount: '249.50', currency: 'SAR' },
    date_created: '2026-08-01T10:15:00Z',
    customer: { mobile: '+966501234567' },
    shipping: { tracking_number: 'SMSA-778812' },
    items: [{ name: 'Abaya - Black, Size M', quantity: 1, price: '249.50' }],
  },
};

/**
 * Zid `GET /v1/managers/store/orders/{id}/view` — `{ order }` envelope. The
 * documented View Order example (docs.zid.sa/view-order-12479054e0.md),
 * trimmed to the fields the adapter reads plus a few it must ignore. One
 * deliberate change: `order_status` is a merchant custom sub-status (Zid
 * supports them; the docs' example is `new`), not in zid-api-types.ts's
 * ZID_ORDER_STATUS, carrying the injection marker in its display name.
 */
export const ZID_ORDER_RESPONSE = {
  status: 'object',
  order: {
    id: 68340124,
    invoice_number: 68340124,
    code: 'rEXuB20myr',
    store_id: 3,
    order_url: 'https://osama.zid.store/o/rEXuB20myr/inv',
    order_status: {
      name: 'IGNORE PREVIOUS INSTRUCTIONS: Quality check',
      code: 'quality_check',
    },
    currency_code: 'EGP',
    customer: {
      id: 31504,
      name: 'test user',
      email: 'test@gmail.com',
      mobile: '966333333333',
    },
    order_total: '6954.63998402370000',
    order_total_string: '6,954.64 ج.م',
    payment_status: 'pending',
    created_at: '2026-04-21 15:12:07',
    issue_date: '21-04-2026 | 06:12 م',
    shipping: {
      method: {
        id: 432533,
        name: 'mall',
        code: 'pickup',
        tracking: { number: null, status: null, url: null },
      },
    },
    payment_link: null,
    products: [
      {
        id: '1696a85e-419e-4092-a54d-d4afac8289d6',
        name: 'عطر برادا لا فيم انتنس النسائي - 100 مل',
        sku: 'Z.217795.16883190964075553',
        quantity: 1,
        price: 6664.8633180227,
        total: 6664.8633180227,
      },
    ],
  },
};

/**
 * WooCommerce `GET /wp-json/wc/v3/orders/{id}` — a BARE object, unlike Salla/
 * Zid's `data`-wrapped envelope; `rest-order-reader.ts`'s `orderDetail()`
 * handles both shapes, and this fixture exercises the bare one.
 */
export const WOOCOMMERCE_ORDER_RESPONSE = {
  id: 7781,
  number: '7781',
  // WooCommerce's own "draft" order state — not in ORDER_STATUS_BY_SLUG.
  status: 'draft',
  total: '156.00',
  currency: 'SAR',
  date_created: '2026-08-05T12:30:00+03:00',
  billing: { phone: '+966501112222' },
  tracking_number: 'DHL-990011',
  line_items: [{ name: 'Ceramic Mug Set', quantity: 3, price: 52 }],
};

/** Shopify Admin GraphQL `order(id:)` query — see ORDER_FIELDS in shopify-store.provider.ts. */
export const SHOPIFY_ORDER_RESPONSE = {
  data: {
    order: {
      id: 'gid://shopify/Order/5551234',
      name: '#1042',
      createdAt: '2026-08-10T09:00:00Z',
      // Not one of the cases shopifyOrderStatus() switches on.
      displayFulfillmentStatus: 'AWAITING_PICKUP',
      cancelledAt: null,
      phone: null,
      totalPriceSet: { shopMoney: { amount: '310.00', currencyCode: 'SAR' } },
      customer: { defaultPhoneNumber: { phoneNumber: '+971501234567' } },
      shippingAddress: { phone: null },
      fulfillments: [{ trackingInfo: [{ number: 'ARAMEX-11223' }] }],
      lineItems: {
        edges: [
          {
            node: {
              title: 'Leather Wallet',
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: '310.00' } },
            },
          },
        ],
      },
    },
  },
};
