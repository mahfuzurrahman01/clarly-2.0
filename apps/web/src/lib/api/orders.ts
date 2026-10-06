import {
  API_BASE_URL,
  ApiError,
  apiFetch,
  browserAccessToken,
  browserApiFetch,
  reportIfSubscriptionInactive,
} from "./client";

/**
 * Feature 25 (Orders in Chat) — console-side client for `/orders` and
 * `/orders/settings`. Mirrors the F25 handoff entry in docs/HANDOFF.md, which
 * is the contract of record.
 *
 * Four wire details that bite if you assume otherwise:
 *  - Money (`subtotal`, `total`, `unitPrice`, `lineTotal`) is a **decimal
 *    string** (`"349.00"`), never a number. Format it, never arithmetic it.
 *  - `status` and `storeSyncStatus` are **separate lifecycles**. A store
 *    outage never changes the order's status: `confirmed` +
 *    `storeSyncStatus: "failed"` is a real order that hasn't reached the
 *    merchant's store yet.
 *  - Listing is **cursor**-paginated, not offset-paginated: `nextCursor` is
 *    opaque, pass it straight back as `cursor`, and `null` means last page.
 *    There is no total count, so the UI cannot show "x of y".
 *  - The list query is `.strict()` server-side — an unknown query key is a
 *    400, not an ignored param. Only send the keys below.
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

export const ORDER_STORE_SYNC_STATUSES = [
  "not_applicable",
  "pending",
  "synced",
  "failed",
] as const;
export type StoreSyncStatus = (typeof ORDER_STORE_SYNC_STATUSES)[number];

/** `disabled` is also the meaning of a **missing** `tenant_order_settings` row. */
export const ORDER_MODES = ["disabled", "human_approval", "auto"] as const;
export type OrderMode = (typeof ORDER_MODES)[number];

/** The five D1.5 gates, in the order the console presents them. */
export const AUTO_ELIGIBILITY_CRITERIA = [
  "human_approval_tenure",
  "decided_orders",
  "rejection_rate",
  "catalog_ready",
  "cod_enabled",
] as const;
export type AutoEligibilityCriterionKey =
  (typeof AUTO_ELIGIBILITY_CRITERIA)[number];

export type OrderView = {
  id: string;
  tenantId: string;
  /** Short, human-quotable reference generated server-side. */
  reference: string;
  customerId: string;
  conversationId: string | null;
  status: OrderStatus;
  contactName: string;
  contactPhone: string;
  city: string | null;
  address: string;
  notes: string | null;
  /** COD is the only phase-1 method, enforced by a DB CHECK constraint. */
  paymentMethod: string;
  paymentStatus: string;
  /** Decimal string. Phase 1 has no VAT or shipping, so `total === subtotal`. */
  subtotal: string;
  total: string;
  currency: string;
  storeConnectionId: string | null;
  storeSyncStatus: StoreSyncStatus;
  externalOrderId: string | null;
  storeSyncAttempts: number;
  storeSyncError: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  /**
   * `null` on a decided order means the WhatsApp 24h service window was closed
   * and the customer was **not** told. The console must surface that.
   */
  customerNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrderItemView = {
  id: string;
  productId: string | null;
  productName: string;
  sku: string | null;
  /** Snapshot taken at order time, not the current catalogue price. */
  unitPrice: string;
  currency: string;
  quantity: number;
  lineTotal: string;
  externalProductId: string | null;
  externalVariantId: string | null;
};

export type OrderPage = { orders: OrderView[]; nextCursor: string | null };

export type OrderDetailResult = { order: OrderView; items: OrderItemView[] };

export type OrderListQuery = {
  status?: OrderStatus;
  storeSyncStatus?: StoreSyncStatus;
  conversationId?: string;
  customerId?: string;
  cursor?: string;
  limit?: number;
};

/** Server default is 20; the API caps `limit` at 100. */
export const ORDERS_PAGE_SIZE = 20;

/** `reason` is 1..500 chars, trimmed, and merchant-internal — never sent to the customer. */
export const MAX_REJECTION_REASON_LENGTH = 500;

/** `approval_window_hours` CHECK constraint, mirrored so the form fails before the round trip. */
export const MIN_APPROVAL_WINDOW_HOURS = 1;
export const MAX_APPROVAL_WINDOW_HOURS = 168;

export function listOrders(query: OrderListQuery = {}, token?: string) {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.storeSyncStatus) params.set("storeSyncStatus", query.storeSyncStatus);
  if (query.conversationId) params.set("conversationId", query.conversationId);
  if (query.customerId) params.set("customerId", query.customerId);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  const path = `/orders${qs ? `?${qs}` : ""}`;
  return token
    ? apiFetch<OrderPage>(path, { token })
    : browserApiFetch<OrderPage>(path);
}

export function getOrder(id: string, token?: string) {
  const path = `/orders/${id}`;
  return token
    ? apiFetch<OrderDetailResult>(path, { token })
    : browserApiFetch<OrderDetailResult>(path);
}

/**
 * Approve. 409 means one of two different things and the caller must tell
 * them apart (see {@link isConflict}): the order is no longer
 * `pending_approval` — somebody else already decided it — or an item went out
 * of stock since the customer ordered. Re-reading the order settles it.
 */
export function approveOrder(id: string) {
  return browserApiFetch<OrderView>(`/orders/${id}/approve`, {
    method: "POST",
  });
}

export function rejectOrder(id: string, reason: string) {
  return browserApiFetch<OrderView>(`/orders/${id}/reject`, {
    method: "POST",
    json: { reason },
  });
}

/** Valid from `confirmed` only; 409 otherwise. */
export function cancelOrder(id: string) {
  return browserApiFetch<OrderView>(`/orders/${id}/cancel`, { method: "POST" });
}

/**
 * Re-queues the store push. Only valid while `storeSyncStatus === "failed"`;
 * 409 otherwise. Does not touch the order itself.
 */
export function retryStorePush(id: string) {
  return browserApiFetch<OrderView>(`/orders/${id}/retry-store-push`, {
    method: "POST",
  });
}

/** True for the "someone else got there first" / "state moved under you" family of failures. */
export function isConflict(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 409;
}

/** True for the admin-role gate on `/orders/settings` (an agent token 403s). */
export function isForbidden(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 403;
}

// --- Settings (admin role; an agent token gets a 403) ---

/** A measured or required value in a criterion's structured evidence. */
export type CriterionEvidenceValue = number | string | boolean;

/**
 * Structured evidence the API sends beside the English `detail` sentence, so
 * the console can write that sentence in its own language. All optional: rows
 * from an API that predates them carry only `detail`.
 */
export type CriterionEvidence = {
  /**
   * What was measured: `human_approval_days`, `approved_orders_count`,
   * `rejection_rate`, `active_products`, `products_linked`,
   * `store_connected` or `cod_enabled`. A code the console doesn't know falls
   * back to `detail`.
   */
  code?: string;
  /** The bar. For `rejection_rate` an exclusive maximum; every other number is a minimum. */
  required?: CriterionEvidenceValue;
  /** What was measured, in the same unit as `required`. */
  actual?: CriterionEvidenceValue;
  /** `days` | `orders` | `percent` | `products`, or null for on/off checks. */
  unit?: string | null;
  /** Any other value the English `detail` interpolates (e.g. `rejected`, `decided`, `activeProducts`). */
  params?: Readonly<Record<string, string | number>> | null;
};

export type AutoEligibilityCriterion = CriterionEvidence & {
  key: AutoEligibilityCriterionKey;
  met: boolean;
  /** Merchant-readable evidence, written by the API in English. The fallback when `code` isn't usable. */
  detail: string;
};

export type AutoEligibility = {
  eligible: boolean;
  measuredAt: string;
  criteria: AutoEligibilityCriterion[];
};

export type OrderSettings = {
  tenantId: string;
  mode: OrderMode;
  codEnabled: boolean;
  approvalWindowHours: number;
  autoEnabledAt: string | null;
  autoEnabledBy: string | null;
  autoEligibilitySnapshot: Record<string, unknown> | null;
  autoEligibility: AutoEligibility;
};

export type UpdateOrderSettingsInput = {
  mode?: OrderMode;
  codEnabled?: boolean;
  approvalWindowHours?: number;
};

export function getOrderSettings(token?: string) {
  return token
    ? apiFetch<OrderSettings>("/orders/settings", { token })
    : browserApiFetch<OrderSettings>("/orders/settings");
}

export type FailedCriterion = CriterionEvidence & { criterion: string; detail: string };

/**
 * The 422 `PATCH /orders/settings` returns when `mode: "auto"` is requested
 * and D1.5 is not satisfied. It carries the **per-criterion** evidence, which
 * `ApiError` (message + status only) cannot express — so the PATCH below does
 * its own fetch rather than going through `apiFetch`, for the same reason
 * `uploadProductImage` does in ./catalog.ts.
 */
export class OrderEligibilityError extends ApiError {
  constructor(
    message: string,
    readonly failedCriteria: FailedCriterion[],
  ) {
    super(422, message);
    this.name = "OrderEligibilityError";
  }
}

export function isEligibilityError(err: unknown): err is OrderEligibilityError {
  return err instanceof OrderEligibilityError;
}

export async function updateOrderSettings(
  input: UpdateOrderSettingsInput,
): Promise<OrderSettings> {
  const token = await browserAccessToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/orders/settings`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR");
  }

  if (res.ok) return (await res.json()) as OrderSettings;

  const body = await readErrorBody(res);
  if (res.status === 422 && body.failedCriteria?.length) {
    throw new OrderEligibilityError(body.message, body.failedCriteria);
  }
  const err = new ApiError(res.status, body.message);
  reportIfSubscriptionInactive(err);
  throw err;
}

async function readErrorBody(
  res: Response,
): Promise<{ message: string; failedCriteria?: FailedCriterion[] }> {
  try {
    const data = (await res.json()) as {
      message?: string | string[];
      failedCriteria?: FailedCriterion[];
    };
    const message = Array.isArray(data.message)
      ? data.message.join(", ")
      : data.message;
    return {
      message: message ?? `Request failed (${res.status})`,
      failedCriteria: Array.isArray(data.failedCriteria)
        ? data.failedCriteria
        : undefined,
    };
  } catch {
    return { message: `Request failed (${res.status})` };
  }
}
