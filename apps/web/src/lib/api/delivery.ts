import { API_BASE_URL, apiFetch, browserApiFetch } from "./client";

/**
 * Feature 26 (Delivery Tracking) — console-side client.
 *
 * Contract of record: the `[F26 — Delivery Tracking (Aramex, SMSA, Naqel,
 * J&T)]` entry in `docs/HANDOFF.md`. Three things there shape this file more
 * than anything else:
 *
 *  1. **Credentials are write-only.** `GET /couriers/connections` returns
 *     booleans (`isActive`, `hasWebhookSecret`) and timestamps, never a
 *     secret and never a masked hint. So there is no `credentials` field on
 *     `CourierConnection` at all — a type that cannot express a stored secret
 *     is a UI that cannot accidentally render one.
 *  2. **Only three of four couriers can be polled and one can be pushed.**
 *     `supportsWebhook` comes back per connection, but the capability is a
 *     property of the courier, not of the row, so it is also declared
 *     statically here (`COURIER_CAPABILITIES`) for the not-yet-connected
 *     case where there is no row to read it from.
 *  3. **There is no `GET /shipments`.** The only shipment read the API ships
 *     is `GET /orders/:orderId/shipments`, so the deliveries screen is
 *     assembled order-by-order over F25's `GET /orders` — see
 *     {@link loadShipmentPage}.
 */

// --- Couriers ---

export const COURIERS = ["aramex", "smsa", "naqel", "jt"] as const;
export type Courier = (typeof COURIERS)[number];

/** Latin brand names. Rendered inside `dir="ltr"` even in the Arabic console. */
export const COURIER_BRAND: Record<Courier, string> = {
  aramex: "Aramex",
  smsa: "SMSA Express",
  naqel: "Naqel Express",
  jt: "J&T Express",
};

/**
 * Push support per courier (F26 D1). Aramex's enterprise tracking push is
 * account-provisioned with no documented signature scheme and Naqel/SMSA
 * document none at all, so the platform accepts a callback from J&T only.
 * The console must not offer a webhook URL for the other three — there is no
 * route that would answer it, and `POST /couriers/connections/:id/webhook-secret`
 * 404s for them.
 */
export const COURIER_CAPABILITIES: Record<Courier, { supportsWebhook: boolean }> =
  {
    aramex: { supportsWebhook: false },
    smsa: { supportsWebhook: false },
    naqel: { supportsWebhook: false },
    jt: { supportsWebhook: true },
  };

/** A single credential input. `secret: true` renders as a password field. */
export type CredentialField = { key: string; secret: boolean };

/**
 * The credential map each courier's API wants. `credentials` is free-form on
 * the wire because its shape belongs to the courier; this is the transcription
 * of the shapes the handoff entry lists, used to build the form and to refuse
 * a half-filled submission before the round trip.
 *
 * Every field is required on every submit: the endpoint upserts the whole
 * blob, so there is no such thing as changing one credential in isolation.
 */
export const COURIER_CREDENTIAL_FIELDS: Record<Courier, CredentialField[]> = {
  aramex: [
    { key: "username", secret: false },
    { key: "password", secret: true },
    { key: "accountNumber", secret: false },
    { key: "accountPin", secret: true },
    { key: "accountEntity", secret: false },
    { key: "accountCountryCode", secret: false },
  ],
  smsa: [{ key: "apiKey", secret: true }],
  naqel: [
    { key: "clientId", secret: false },
    { key: "password", secret: true },
  ],
  jt: [
    { key: "apiAccount", secret: false },
    { key: "privateKey", secret: true },
  ],
};

/**
 * What `GET /couriers/connections` returns. Note what is absent: no
 * `credentials`, no `webhookSecret`, no masked hint of either. The API has
 * none to give, so neither does this type.
 */
export type CourierConnection = {
  id: string;
  courier: Courier;
  accountRef: string;
  isActive: boolean;
  supportsWebhook: boolean;
  hasWebhookSecret: boolean;
  lastVerifiedAt: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The create/update response. `verificationError` is present only when the
 * courier rejected the credentials — the row was still stored, inactive, and
 * the string is the courier's own wording. Show it verbatim; do not translate
 * or paraphrase it.
 */
export type CourierConnectionResult = CourierConnection & {
  verificationError?: string;
};

export type UpsertCourierConnectionInput = {
  courier: Courier;
  accountRef: string;
  credentials: Record<string, string>;
};

export function listCourierConnections(token?: string) {
  const path = "/couriers/connections";
  return token
    ? apiFetch<CourierConnection[]>(path, { token })
    : browserApiFetch<CourierConnection[]>(path);
}

/**
 * `POST /couriers/connections` — upserts on `(tenant, courier, accountRef)`,
 * so re-entering credentials refreshes the existing row rather than creating
 * a second one. The credentials are called against the courier before the row
 * is activated, which is why this request is slow enough to need a pending
 * state in the form.
 */
export function upsertCourierConnection(input: UpsertCourierConnectionInput) {
  return browserApiFetch<CourierConnectionResult>("/couriers/connections", {
    method: "POST",
    json: input,
  });
}

/** Deactivates the connection (`isActive: false`); polling for it stops. */
export function disconnectCourier(id: string) {
  return browserApiFetch<void>(`/couriers/connections/${id}`, {
    method: "DELETE",
  });
}

/**
 * Mints a new push secret and returns it **once** — it is never readable
 * again, so the caller has to show it immediately or lose it. 404 for a
 * poll-only courier, which is why the button only exists for J&T.
 */
export function rotateWebhookSecret(id: string) {
  return browserApiFetch<{ webhookSecret: string }>(
    `/couriers/connections/${id}/webhook-secret`,
    { method: "POST" },
  );
}

/**
 * The callback URL the merchant pastes into their courier console. Built from
 * the public API base and the connection's own routing key.
 */
export function courierWebhookUrl(
  courier: Courier,
  accountRef: string,
): string {
  return `${API_BASE_URL}/couriers/webhook/${courier}/${encodeURIComponent(accountRef)}`;
}

// --- Delivery notification settings ---

/**
 * The only statuses a tenant may map to a template. Anything else is a 400
 * from `PUT /settings/delivery-notifications`; a status with no mapping is
 * never notified.
 */
export const NOTIFIABLE_STATUSES = [
  "picked_up",
  "out_for_delivery",
  "delivered",
  "failed_attempt",
  "returned",
] as const;
export type NotifiableStatus = (typeof NOTIFIABLE_STATUSES)[number];

export type DeliveryNotificationSettings = {
  enabled: boolean;
  statusTemplates: Partial<Record<NotifiableStatus, string>>;
  updatedAt: string | null;
};

/**
 * Opt-in, never opt-out: these are billed, business-initiated templates. A
 * tenant that has never visited this screen has no settings row, so the
 * console renders the off state — {@link DELIVERY_NOTIFICATIONS_OFF} is what
 * a missing or unreadable row means, and the UI must not invent an "on".
 */
export const DELIVERY_NOTIFICATIONS_OFF: DeliveryNotificationSettings = {
  enabled: false,
  statusTemplates: {},
  updatedAt: null,
};

export function getDeliveryNotificationSettings(token?: string) {
  const path = "/settings/delivery-notifications";
  return token
    ? apiFetch<DeliveryNotificationSettings>(path, { token })
    : browserApiFetch<DeliveryNotificationSettings>(path);
}

export function updateDeliveryNotificationSettings(input: {
  enabled: boolean;
  statusTemplates: Partial<Record<NotifiableStatus, string>>;
}) {
  return browserApiFetch<DeliveryNotificationSettings>(
    "/settings/delivery-notifications",
    { method: "PUT", json: input },
  );
}

// --- Shipments ---

/**
 * The normalized vocabulary. Courier wording is mapped into this before it
 * reaches the console; the courier's own code survives only as `rawStatus` on
 * a history entry.
 */
export const SHIPMENT_STATUSES = [
  "label_created",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "failed_attempt",
  "returned",
  "cancelled",
  "exception",
  "unknown",
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * The forward-only spine the backend's monotonic guard walks. A courier can
 * replay an older event and it is recorded in history, but it never moves the
 * shipment backwards — so the timeline is drawn against this order, and an
 * event that sits below the high-water mark is shown as recorded-but-not-
 * advancing rather than as a step backwards.
 *
 * The remaining statuses (`failed_attempt`, `returned`, `cancelled`,
 * `exception`, `unknown`) are outcomes, not positions, and have no rank.
 */
export const SHIPMENT_PROGRESS: readonly ShipmentStatus[] = [
  "label_created",
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
];

export function progressRank(status: ShipmentStatus): number {
  return SHIPMENT_PROGRESS.indexOf(status);
}

/** A shipment nobody will poll again. */
export function isTerminalStatus(status: ShipmentStatus): boolean {
  return status === "delivered" || status === "returned" || status === "cancelled";
}

export const STATUS_SOURCES = ["poll", "webhook", "manual"] as const;
export type StatusSource = (typeof STATUS_SOURCES)[number];

export type ShipmentStatusEvent = {
  status: ShipmentStatus;
  /** The courier's own status code. Support/debug only — never shown to a customer. */
  rawStatus: string;
  location: string | null;
  occurredAt: string;
  source: StatusSource;
};

export type Shipment = {
  id: string;
  orderId: string;
  courier: Courier;
  trackingNumber: string;
  currentStatus: ShipmentStatus;
  currentStatusAt: string | null;
  /** Almost always null: no adapter reads an ETA field yet. Never assume a date. */
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  lastNotifiedStatus: ShipmentStatus | null;
  lastNotifiedAt: string | null;
  lastPolledAt: string | null;
  pollFailureCount: number;
  history: ShipmentStatusEvent[];
};

export function listOrderShipments(orderId: string, token?: string) {
  const path = `/orders/${orderId}/shipments`;
  return token
    ? apiFetch<Shipment[]>(path, { token })
    : browserApiFetch<Shipment[]>(path);
}

/** Mirrors `createShipmentSchema.trackingNumber` in the API's `courier.dto.ts`. */
export const MAX_TRACKING_NUMBER_LENGTH = 128;

export type CreateShipmentInput = {
  courier: Courier;
  courierConnectionId: string;
  trackingNumber: string;
};

/**
 * `POST /orders/:orderId/shipments` — admin only. Records a parcel the
 * merchant already handed to a courier; it does not book a pickup. Upserts on
 * `(tenant, courier, trackingNumber)`, so a double submit returns the same
 * shipment rather than a second one. 400 when the connection is inactive or
 * belongs to a different courier than `courier`, 404 for an unknown order or
 * connection.
 */
export function createOrderShipment(
  orderId: string,
  input: CreateShipmentInput,
) {
  return browserApiFetch<Shipment>(`/orders/${orderId}/shipments`, {
    method: "POST",
    json: input,
  });
}

export type OrderShipmentsData = {
  shipments: Shipment[];
  /** Active connections only. */
  connections: CourierConnection[];
};

/**
 * Loads the card's data. Pass `token` from a server component; omit it in the
 * browser. Inactive connections are dropped here because the API 400s on
 * them and their shipments would never be polled.
 */
export async function loadOrderShipments(
  orderId: string,
  token?: string,
): Promise<OrderShipmentsData> {
  const [shipments, connections] = await Promise.all([
    listOrderShipments(orderId, token),
    listCourierConnections(token),
  ]);
  return {
    shipments,
    connections: connections.filter((connection) => connection.isActive),
  };
}

/** Most recent webhook-sourced event, i.e. when a push last converged this shipment. */
export function lastWebhookEvent(
  shipment: Shipment,
): ShipmentStatusEvent | null {
  return (
    shipment.history
      .filter((event) => event.source === "webhook")
      .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0] ??
    null
  );
}

// --- Orders, as far as the shipment view needs them ---

/**
 * F25's order statuses, repeated (not imported) so this lane's list filter
 * does not couple to the orders lane's client module. Only the fields the
 * deliveries screen renders are typed here — `GET /orders` returns a much
 * wider `OrderView`.
 */
export const ORDER_STATUSES = [
  "pending_approval",
  "confirmed",
  "rejected",
  "expired",
  "cancelled",
  "fulfilled",
  "failed",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type ShipmentOrderRef = {
  id: string;
  reference: string;
  status: OrderStatus;
  contactName: string | null;
  city: string | null;
  createdAt: string;
};

type OrderListResponse = {
  orders: ShipmentOrderRef[];
  nextCursor: string | null;
};

/** `GET /orders` pages by opaque cursor; 20 is the API's own default. */
export const DELIVERIES_ORDER_PAGE_SIZE = 20;

/** A shipment paired with the order it belongs to, which is how the list reads. */
export type ShipmentRow = { shipment: Shipment; order: ShipmentOrderRef };

export type ShipmentPage = {
  rows: ShipmentRow[];
  /** Orders scanned to produce `rows` — the honest denominator for "no shipments found". */
  ordersScanned: number;
  nextCursor: string | null;
};

/**
 * Assembles a page of the deliveries screen.
 *
 * F26 shipped no tenant-wide shipment list — `GET /orders/:orderId/shipments`
 * is the only read — so a page of orders is fetched first and its shipments
 * are read in parallel. That is N+1 by contract, not by accident; it is
 * bounded by {@link DELIVERIES_ORDER_PAGE_SIZE} and the page size is why.
 *
 * A single order's shipment read failing must not blank the whole screen: it
 * is treated as "no shipments for this order" and the rest of the page still
 * renders.
 */
export async function loadShipmentPage(
  query: { status?: OrderStatus; cursor?: string } = {},
  token?: string,
): Promise<ShipmentPage> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(DELIVERIES_ORDER_PAGE_SIZE));
  const path = `/orders?${params.toString()}`;

  const page = token
    ? await apiFetch<OrderListResponse>(path, { token })
    : await browserApiFetch<OrderListResponse>(path);

  const perOrder = await Promise.all(
    page.orders.map(async (order) => {
      try {
        const shipments = await listOrderShipments(order.id, token);
        return shipments.map((shipment) => ({ shipment, order }));
      } catch {
        return [] as ShipmentRow[];
      }
    }),
  );

  return {
    rows: perOrder.flat(),
    ordersScanned: page.orders.length,
    nextCursor: page.nextCursor,
  };
}
