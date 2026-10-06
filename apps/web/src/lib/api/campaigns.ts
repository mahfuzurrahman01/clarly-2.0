// Feature 19 (Campaigns & Broadcast) — console-side client.
//
// Contract of record: docs/HANDOFF.md, the two F19 entries
// ("first slice", 2026-09-21, and "send path", 2026-09-22). Behaviour that
// the UI must respect: docs/decisions/F19-campaigns-broadcast.md (D1-D5).
//
// Three wire details that bite if you assume otherwise:
//  - `GET /campaigns` returns `{ campaigns, total }` where `total` is the
//    length of THIS page, not the collection size. Pagination here is
//    therefore "is this page full?", never "page 3 of 12".
//  - The three refusals of `POST /campaigns/:id/schedule` and
//    `/resume` carry structured bodies (`blocks`, `requiredCapUsd`) that the
//    shared `apiFetch` error path throws away — it keeps `message` only.
//    Those two calls therefore go through `postCampaignAction` below, which
//    reads the raw body and returns a typed refusal.
//  - Money is a JSON number here (the API parses the numerics), unlike the
//    catalog's decimal strings. Every cost is an *estimate* from a static
//    price table — label it as such wherever it is shown.
import {
  API_BASE_URL,
  ApiError,
  apiFetch,
  browserAccessToken,
  browserApiFetch,
  reportIfSubscriptionInactive,
} from "./client";

// ---------------------------------------------------------------------------
// Segments — D1's grammar
// ---------------------------------------------------------------------------

export const CHANNEL_KINDS = ["whatsapp", "messenger", "instagram"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export type SegmentCriterion =
  | { kind: "label"; in: string[] }
  | { kind: "tag"; hasAny: string[] }
  | { kind: "channel"; in: ChannelKind[] }
  | { kind: "customer_created"; within_days: number }
  | { kind: "customer_created_before"; days_ago: number }
  | { kind: "last_inbound_within_days"; days: number }
  | { kind: "last_inbound_before_days"; days: number }
  | { kind: "order_count"; op: "gte" | "lte"; value: number }
  | { kind: "order_total_usd"; op: "gte" | "lte"; value: number }
  | { kind: "last_order_within_days"; days: number }
  | { kind: "never_ordered" };

export type SegmentCriterionKind = SegmentCriterion["kind"];

export type SegmentNode =
  | SegmentCriterion
  | { kind: "and"; children: SegmentNode[] }
  | { kind: "or"; children: SegmentNode[] }
  | { kind: "not"; child: SegmentNode };

/** The grammar's own structural limits (D1), mirrored so the builder refuses before the round trip. */
export const MAX_SEGMENT_LEAVES = 20;
export const MAX_SEGMENT_NAME_LENGTH = 100;
export const MAX_SEGMENT_DESCRIPTION_LENGTH = 500;
export const MAX_CRITERION_LIST_VALUES = 20;
export const MAX_CRITERION_VALUE_LENGTH = 64;

/** How a criterion's operand is captured. Drives one editor component per shape rather than one per kind. */
export type CriterionInput =
  | { form: "strings" }
  | { form: "channels" }
  | { form: "days"; min: number; max: number }
  | { form: "amount"; min: number; max: number; integer: boolean }
  | { form: "none" };

export type CriterionSpec = {
  kind: SegmentCriterionKind;
  input: CriterionInput;
  /**
   * False for a criterion the grammar accepts but the compiler refuses with
   * `SegmentCriterionNotImplementedError`. The builder offers it disabled
   * with a "not available yet" note instead of hiding it, so a merchant can
   * see the criterion is coming rather than wonder where it went.
   *
   * Turning one on is a one-word data change here — nothing else branches on
   * the kind. The four order-history criteria were exactly this until F25's
   * `orders` table landed on 2026-09-22; all eleven compile today.
   * `isCriterionNotImplemented` below still catches a server that disagrees
   * with this table, so a stale flag degrades to an inline explanation
   * rather than an unexplained failure.
   */
  supported: boolean;
};

export const SEGMENT_CRITERIA: readonly CriterionSpec[] = [
  { kind: "label", input: { form: "strings" }, supported: true },
  { kind: "tag", input: { form: "strings" }, supported: true },
  { kind: "channel", input: { form: "channels" }, supported: true },
  {
    kind: "customer_created",
    input: { form: "days", min: 1, max: 3650 },
    supported: true,
  },
  {
    kind: "customer_created_before",
    input: { form: "days", min: 1, max: 3650 },
    supported: true,
  },
  {
    kind: "last_inbound_within_days",
    input: { form: "days", min: 1, max: 365 },
    supported: true,
  },
  {
    kind: "last_inbound_before_days",
    input: { form: "days", min: 1, max: 365 },
    supported: true,
  },
  {
    kind: "order_count",
    input: { form: "amount", min: 0, max: 100000, integer: true },
    supported: true,
  },
  {
    kind: "order_total_usd",
    input: { form: "amount", min: 0, max: 1e9, integer: false },
    supported: true,
  },
  {
    kind: "last_order_within_days",
    input: { form: "days", min: 1, max: 3650 },
    supported: true,
  },
  { kind: "never_ordered", input: { form: "none" }, supported: true },
];

export function criterionSpec(kind: SegmentCriterionKind): CriterionSpec {
  const spec = SEGMENT_CRITERIA.find((entry) => entry.kind === kind);
  if (!spec) throw new Error(`Unknown segment criterion: ${kind}`);
  return spec;
}

/**
 * True when a failure is the compiler's "this criterion depends on a table
 * that has not landed" — which reaches the client as a 500, because no
 * exception filter maps it (see the report note on this). Matched on the
 * server's own sentence so the UI can say "not available yet" instead of
 * "something went wrong".
 */
export function isCriterionNotImplemented(err: unknown): boolean {
  return (
    err instanceof ApiError && /is not implemented yet/i.test(err.message)
  );
}

export type SegmentRecord = {
  id: string;
  name: string;
  description: string | null;
  definition: SegmentNode;
  /** Advisory cache of the last preview. Never used to decide who gets a message. */
  lastResolvedCount: number | null;
  lastResolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SegmentPreview = { count: number; resolvedAt: string };

export type SegmentInput = {
  name: string;
  description?: string | null;
  definition: SegmentNode;
};

export function listSegments(token?: string) {
  return token
    ? apiFetch<SegmentRecord[]>("/segments", { token })
    : browserApiFetch<SegmentRecord[]>("/segments");
}

export function createSegment(input: SegmentInput) {
  return browserApiFetch<SegmentRecord>("/segments", {
    method: "POST",
    json: input,
  });
}

export function updateSegment(id: string, input: Partial<SegmentInput>) {
  return browserApiFetch<SegmentRecord>(`/segments/${id}`, {
    method: "PUT",
    json: input,
  });
}

export function deleteSegment(id: string) {
  return browserApiFetch<void>(`/segments/${id}`, { method: "DELETE" });
}

/** COUNT(*) only — never writes a recipient row, so it is safe to call on every edit. */
export function previewSegment(id: string) {
  return browserApiFetch<SegmentPreview>(`/segments/${id}/preview`, {
    method: "POST",
  });
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "paused_spend_cap",
  "paused_template",
  "paused_manual",
  "paused_eligibility",
  "completed",
  "canceled",
  "failed",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const PAUSED_STATUSES = [
  "paused_spend_cap",
  "paused_template",
  "paused_manual",
  "paused_eligibility",
] as const satisfies readonly CampaignStatus[];
export type PausedStatus = (typeof PAUSED_STATUSES)[number];

export function isPaused(status: CampaignStatus): status is PausedStatus {
  return (PAUSED_STATUSES as readonly string[]).includes(status);
}

/** Terminal: nothing is pending or sending, and no lifecycle verb applies. */
export function isTerminal(status: CampaignStatus): boolean {
  return status === "completed" || status === "canceled" || status === "failed";
}

export type CampaignTemplateValue =
  | { type: "literal"; value: string }
  | { type: "customer_field"; field: "name" | "phone"; fallback: string };

export type CampaignRecord = {
  id: string;
  name: string;
  segmentId: string;
  templateId: string;
  templateValues: CampaignTemplateValue[];
  phoneNumberId: string;
  status: CampaignStatus;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Written once, at snapshot. Zero until the campaign has launched. */
  recipientCount: number;
  estimatedCostUsd: number;
  spendCapUsd: number;
  spentUsd: number;
  /** The human sentence behind a `paused_*` status. Show it verbatim. */
  pauseReason: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignStats = {
  campaignId: string;
  status: CampaignStatus;
  recipientCount: number;
  pending: number;
  sending: number;
  sent: number;
  failed: number;
  skipped: number;
  /** Counts `read` too — `read > delivered` is impossible by construction. */
  delivered: number;
  read: number;
  /** Last-touch attribution over a 7-day window, not multi-touch. */
  replied: number;
  skippedByReason: Record<string, number>;
  spentUsd: number;
  spendCapUsd: number;
  estimatedCostUsd: number;
};

export const RECIPIENT_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
  "skipped",
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const SKIP_REASONS = [
  "opted_out",
  "canceled",
  "no_conversation",
  "invalid_phone",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type CampaignRecipient = {
  id: string;
  customerId: string;
  phone: string;
  status: RecipientStatus;
  skipReason: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  costUsd: number | null;
  attemptCount: number;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
};

export const CAMPAIGNS_PAGE_SIZE = 20;
export const RECIPIENTS_PAGE_SIZE = 20;
export const MAX_CAMPAIGN_NAME_LENGTH = 100;

export type CampaignListResult = {
  campaigns: CampaignRecord[];
  /** Rows on THIS page — the API has no collection count. See the file header. */
  total: number;
};

export type CampaignInput = {
  name: string;
  segmentId: string;
  templateId: string;
  templateValues: CampaignTemplateValue[];
  phoneNumberId: string;
  spendCapUsd?: number;
};

export function listCampaigns(
  params: { limit?: number; offset?: number } = {},
  token?: string,
) {
  const qs = new URLSearchParams({
    limit: String(params.limit ?? CAMPAIGNS_PAGE_SIZE),
    offset: String(params.offset ?? 0),
  });
  const path = `/campaigns?${qs.toString()}`;
  return token
    ? apiFetch<CampaignListResult>(path, { token })
    : browserApiFetch<CampaignListResult>(path);
}

export function getCampaign(id: string, token?: string) {
  const path = `/campaigns/${id}`;
  return token
    ? apiFetch<CampaignRecord>(path, { token })
    : browserApiFetch<CampaignRecord>(path);
}

export function createCampaign(input: CampaignInput) {
  return browserApiFetch<CampaignRecord>("/campaigns", {
    method: "POST",
    json: input,
  });
}

/** Draft only — 409 with `Cannot edit a campaign that is "<status>"` otherwise. */
export function updateCampaign(id: string, input: Partial<CampaignInput>) {
  return browserApiFetch<CampaignRecord>(`/campaigns/${id}`, {
    method: "PUT",
    json: input,
  });
}

export function getCampaignStats(id: string, token?: string) {
  const path = `/campaigns/${id}/stats`;
  return token
    ? apiFetch<CampaignStats>(path, { token })
    : browserApiFetch<CampaignStats>(path);
}

export function listCampaignRecipients(
  id: string,
  params: { limit?: number; offset?: number; status?: RecipientStatus } = {},
  token?: string,
) {
  const qs = new URLSearchParams({
    limit: String(params.limit ?? RECIPIENTS_PAGE_SIZE),
    offset: String(params.offset ?? 0),
  });
  if (params.status) qs.set("status", params.status);
  const path = `/campaigns/${id}/recipients?${qs.toString()}`;
  return token
    ? apiFetch<CampaignRecipient[]>(path, { token })
    : browserApiFetch<CampaignRecipient[]>(path);
}

// ---------------------------------------------------------------------------
// Lifecycle + the three refusals
// ---------------------------------------------------------------------------

export const ELIGIBILITY_BLOCK_REASONS = [
  "number_not_found",
  "number_not_active",
  "messaging_restricted",
  "quality_red",
  "no_payment_method",
  "tier_unknown",
  "over_tier_span",
  "business_not_verified",
  "verification_unknown",
  "billing_blocked",
  // Added 2026-09-22 with `message_templates.waba_id`: a template approved on
  // one WABA cannot send from a number on another, and a null on either side
  // blocks too (fail-closed). Not in the revocable per-batch subset, so it
  // can prevent a launch but never pauses a campaign already sending.
  "template_waba_mismatch",
] as const;
export type EligibilityBlockReason =
  (typeof ELIGIBILITY_BLOCK_REASONS)[number];

/** `message` is written for a merchant, not for a log — render it. */
export type EligibilityBlock = { reason: string; message: string };

/**
 * Why `schedule`/`resume` said no. Structured, because each one has a
 * different fix and a merchant should not have to read a sentence to find
 * out which.
 */
export type CampaignRefusal =
  | { kind: "template"; message: string }
  | {
      kind: "spend_cap";
      message: string;
      estimatedCostUsd: number;
      spendCapUsd: number;
      requiredCapUsd: number;
    }
  | { kind: "eligibility"; message: string; blocks: EligibilityBlock[] }
  | { kind: "state"; message: string }
  | { kind: "other"; message: string };

export class CampaignRefusalError extends Error {
  constructor(readonly refusal: CampaignRefusal) {
    super(refusal.message);
    this.name = "CampaignRefusalError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bodyMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const { message } = body;
  if (Array.isArray(message)) return message.join(", ");
  return typeof message === "string" && message ? message : fallback;
}

/**
 * The 409 from a lifecycle verb applied to the wrong status reads
 * `Cannot <verb> a campaign that is "<status>".` — the only way to tell it
 * apart from the template gate's 409, which has no machine-readable code.
 */
function classify(status: number, body: unknown): CampaignRefusal {
  const message = bodyMessage(body, `Request failed (${status})`);

  if (status === 409) {
    return /^cannot\s/i.test(message)
      ? { kind: "state", message }
      : { kind: "template", message };
  }

  if (status === 422 && isRecord(body)) {
    if (Array.isArray(body.blocks)) {
      const blocks = body.blocks.filter(isRecord).map((block) => ({
        reason: String(block.reason ?? ""),
        message: String(block.message ?? ""),
      }));
      return { kind: "eligibility", message, blocks };
    }
    if (typeof body.requiredCapUsd === "number") {
      return {
        kind: "spend_cap",
        message,
        estimatedCostUsd: Number(body.estimatedCostUsd ?? 0),
        spendCapUsd: Number(body.spendCapUsd ?? 0),
        requiredCapUsd: body.requiredCapUsd,
      };
    }
  }

  return { kind: "other", message };
}

/**
 * POSTs a lifecycle verb and, on a refusal, throws `CampaignRefusalError`
 * carrying the parsed body. `apiFetch` cannot be used for these: it reduces
 * every error body to its `message`, which would drop the eligibility block
 * list and the three spend-cap numbers the merchant needs.
 */
async function postCampaignAction(
  id: string,
  action: "schedule" | "pause" | "resume" | "cancel",
  json?: unknown,
): Promise<CampaignRecord> {
  const token = await browserAccessToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/campaigns/${id}/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR");
  }

  const text = await res.text();
  const body: unknown = text ? safeParse(text) : null;

  if (!res.ok) {
    const err = new ApiError(res.status, bodyMessage(body, `Request failed (${res.status})`));
    // Keeps the one global "subscription is not active" dialog wired up for
    // these calls too, exactly as browserApiFetch does for everything else.
    reportIfSubscriptionInactive(err);
    if (res.status === 409 || res.status === 422) {
      throw new CampaignRefusalError(classify(res.status, body));
    }
    throw err;
  }

  return body as CampaignRecord;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Schedule — or send now. An absent/null/past `sendAt` means immediately;
 * pressing Send and scheduling a time that has arrived are the same
 * operation, so they are deliberately not two endpoints.
 */
export function scheduleCampaign(id: string, sendAt: string | null) {
  return postCampaignAction(id, "schedule", { sendAt });
}

export function pauseCampaign(id: string) {
  return postCampaignAction(id, "pause");
}

/** Re-runs the template gate, the spend cap (counting money already spent) and eligibility — so it can refuse. */
export function resumeCampaign(id: string) {
  return postCampaignAction(id, "resume");
}

export function cancelCampaign(id: string) {
  return postCampaignAction(id, "cancel");
}
