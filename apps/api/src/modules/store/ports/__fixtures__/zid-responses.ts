// F24 Zid unit-test fixtures, transcribed from the response examples on
// docs.zid.sa (2026-10-03) and trimmed to what the adapter reads. Not
// observed from a live store. The View Order fixture lives in
// store-responses.ts (ZID_ORDER_RESPONSE) because the contract suite uses it.

/** `POST https://oauth.zid.sa/oauth/token` (fields per docs + express-sample-app). */
export const ZID_TOKEN_RESPONSE = {
  access_token: 'zid-manager-token',
  authorization: 'zid-partner-token',
  refresh_token: 'zid-refresh-token',
  token_type: 'Bearer',
  expires_in: 31536000,
};

/** `GET /v1/managers/account/profile` (docs.zid.sa/get-manager-profile.md), trimmed. */
export const ZID_PROFILE_RESPONSE = {
  status: 'object',
  user: {
    id: 3,
    name: 'John',
    email: 'os1987@yahoo.com',
    mobile: '966500000005',
    store: {
      id: 3,
      uuid: 'd297fb8b-c322-412e-a2f4-ffa96dc57022',
      username: 'متجر أسامة.',
      title: 'متجر أسامة.',
      url: 'https://osama.zid.store/',
      currency: { id: 4, name: 'Saudi Riyal', code: 'SAR', symbol: ' ر.س ' },
    },
  },
};

/** `GET /v1/products/` (docs.zid.sa/retrieve-a-list-of-products.md), trimmed. */
export const ZID_PRODUCT_LIST_RESPONSE = {
  total_products_count: 2282,
  next: 'http://api.zid.sa/v1/products/?is_infinite=false&page=2&page_size=15',
  previous: null,
  count: 175,
  results: [
    {
      id: 'a1477bb2-72ea-4be9-b2cf-093cefc721bb',
      product_class: 'voucher',
      sku: 'Z.1770805225810645',
      parent_id: null,
      name: { ar: 'قسيمة', en: 'voucher' },
      price: 100,
      sale_price: null,
      currency: 'SAR',
      categories: [
        {
          id: '1473476',
          name: { en: 'Electronics', ar: 'إلكترونيات' },
        },
      ],
      images: [],
      is_draft: false,
      quantity: 4,
      is_infinite: false,
      html_url: 'https://osama.zid.store/products/قسيمة',
      structure: 'standalone',
      store_id: 3,
      is_published: true,
    },
    {
      id: 'a497974d-1755-423a-b06c-e0578ba8c318',
      product_class: null,
      sku: 'WH-1000XX3',
      parent_id: null,
      name: { ar: 'تويتر', en: 'twitter' },
      price: 257,
      sale_price: 199,
      currency: 'SAR',
      categories: [],
      images: [
        {
          id: '4179cc54-1900-4860-9d4a-0cdc4935314c',
          image: {
            large:
              'https://media.zid.store/thumbs/d297fb8b-c322-412e-a2f4-ffa96dc57022/4179cc54-1900-4860-9d4a-0cdc4935314c-thumbnail-1000x1000.png',
            medium:
              'https://media.zid.store/thumbs/d297fb8b-c322-412e-a2f4-ffa96dc57022/4179cc54-1900-4860-9d4a-0cdc4935314c-thumbnail-770x770.png',
            small:
              'https://media.zid.store/thumbs/d297fb8b-c322-412e-a2f4-ffa96dc57022/4179cc54-1900-4860-9d4a-0cdc4935314c-thumbnail-500x500.png',
            thumbnail:
              'https://media.zid.store/thumbs/d297fb8b-c322-412e-a2f4-ffa96dc57022/4179cc54-1900-4860-9d4a-0cdc4935314c-thumbnail-370x370.png',
            full_size:
              'https://media.zid.store/thumbs/d297fb8b-c322-412e-a2f4-ffa96dc57022/4179cc54-1900-4860-9d4a-0cdc4935314c-thumbnail-1000x1000.png',
          },
          alt_text: '',
        },
      ],
      is_draft: false,
      quantity: null,
      is_infinite: true,
      structure: 'standalone',
      store_id: 3,
      is_published: true,
    },
  ],
};

/** `GET /v1/managers/store/orders` (docs.zid.sa/list-of-orders.md), trimmed. */
export const ZID_ORDER_LIST_RESPONSE = {
  status: 'object',
  orders: [
    {
      id: 64102971,
      invoice_number: 64102971,
      code: 'gsQNlvfHmT',
      store_id: 3,
      order_status: { name: 'New', code: 'new' },
      currency_code: 'SAR',
      customer: {
        id: 59292,
        name: 'new test sokolov 6',
        email: 'b.alenezi@zid.sa',
        mobile: '966591555966',
      },
      order_total: '100003.44948170000000',
      payment_status: 'paid',
      created_at: '2026-01-28 21:20:01',
      products: [
        {
          id: '36a8ecc9-e5b2-4cda-ae51-3e7606cf5ebd',
          name: 'sdfd',
          sku: 'Z.17654467807426183',
          quantity: 1,
          price: 99999.999481699,
        },
      ],
    },
  ],
  total_order_count: 1,
};

/** Create Webhook 200 (docs.zid.sa/create-a-webhook.md), trimmed. */
export const ZID_CREATE_WEBHOOK_RESPONSE = {
  status: 'object',
  data: {
    id: 'e307483e-795b-4e9c-8f36-a06cb1cf54bf',
    event: 'order.status.update',
    target_url: 'https://api.example.com/store/webhook/zid/3',
    original_id: '2404',
    active: true,
  },
};

/** Zid's documented 401 envelope. */
export const ZID_UNAUTHORIZED_RESPONSE = {
  status: 'error',
  message: {
    type: 'error',
    code: 'UNAUTHORIZED',
    name: 'Unauthorized',
    description: 'Authentication credentials are missing, invalid, or expired.',
  },
};
