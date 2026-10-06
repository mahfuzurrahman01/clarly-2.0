import { apiFetch, browserApiFetch } from "./client";

export type MessageRole = "user" | "assistant" | "human_agent";
export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";
export type MediaStatus = "pending" | "stored" | "failed" | "too_large";

export type Media = {
  status: MediaStatus;
  mimeType: string | null;
  sizeBytes: number | null;
  filename: string | null;
  error: string | null;
  /** ASR transcript of a voice note, once the agent turn that answered it has run. Null for non-voice attachments and for one that hasn't been processed yet. */
  transcript: string | null;
};

export type FeedbackRating = "up" | "down";

export type ConversationMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  deliveryStatus: DeliveryStatus | null;
  deliveryError: string | null;
  authorUserId: string | null;
  feedback: { rating: FeedbackRating; note: string | null } | null;
  media: Media | null;
};

/** Which Meta channel a conversation arrived on (Feature 16). A badge, never a separate screen. */
/** v2 S3 adds `web` — the website chat widget. */
export type ChannelKind = "whatsapp" | "messenger" | "instagram" | "web";

export type ConversationSummary = {
  id: string;
  channel: ChannelKind;
  /** Channel-scoped identity: a phone on WhatsApp, a PSID/IGSID on Messenger/Instagram. */
  customerPhone: string;
  customerName: string | null;
  lastInboundAt: string;
  lastMessage: { role: MessageRole; content: string; createdAt: string } | null;
  messageCount: number;
  escalated: boolean;
  /** Feature 18: the customer's label (hot/warm/cold), null when no label exists yet. */
  label: string | null;
};

export type ReplyWindow = { open: boolean; expiresAt: string | null };

export type IntakeField = {
  key: string;
  label: string;
  value: string;
  scope: string;
};

export type ConversationDetail = {
  id: string;
  channel: ChannelKind;
  /** Channel-scoped identity: a phone on WhatsApp, a PSID/IGSID on Messenger/Instagram. */
  customerPhone: string;
  customerName: string | null;
  lastInboundAt: string;
  rollingSummary: string | null;
  messageCount: number;
  escalated: boolean;
  createdAt: string;
  handoverState: "agent" | "human";
  handoverAt: string | null;
  handoverUserId: string | null;
  replyWindow: ReplyWindow;
  intake?: IntakeField[];
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type ConversationFilter = {
  cursor?: string;
  phone?: string;
  escalated?: boolean;
  limit?: number;
};

function conversationQuery(filter: ConversationFilter): string {
  const params = new URLSearchParams();
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.cursor) params.set("cursor", filter.cursor);
  if (filter.phone) params.set("phone", filter.phone);
  if (filter.escalated !== undefined)
    params.set("escalated", String(filter.escalated));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function listConversations(filter: ConversationFilter, token?: string) {
  const path = `/conversations${conversationQuery(filter)}`;
  return token
    ? apiFetch<Page<ConversationSummary>>(path, { token })
    : browserApiFetch<Page<ConversationSummary>>(path);
}

export function getConversation(id: string, token?: string) {
  const path = `/conversations/${id}`;
  return token
    ? apiFetch<ConversationDetail>(path, { token })
    : browserApiFetch<ConversationDetail>(path);
}

export function getMessages(
  id: string,
  opts: { limit?: number; cursor?: string } = {},
  token?: string,
) {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.cursor) params.set("cursor", opts.cursor);
  const qs = params.toString();
  const path = `/conversations/${id}/messages${qs ? `?${qs}` : ""}`;
  return token
    ? apiFetch<Page<ConversationMessage>>(path, { token })
    : browserApiFetch<Page<ConversationMessage>>(path);
}

// --- Mutations (browser) ---

export type SendReplyResult = {
  messageId: string;
  delivered: boolean;
  deliveryError: string | null;
};

export function sendReply(id: string, text: string, clientMessageId: string) {
  return browserApiFetch<SendReplyResult>(`/conversations/${id}/messages`, {
    method: "POST",
    json: { text, clientMessageId },
  });
}

export function takeOver(id: string) {
  return browserApiFetch<ConversationDetail>(
    `/conversations/${id}/handover`,
    { method: "POST" },
  );
}

export function handBack(id: string) {
  return browserApiFetch<ConversationDetail>(
    `/conversations/${id}/handover/return`,
    { method: "POST" },
  );
}

export function rateAnswer(
  conversationId: string,
  messageId: string,
  rating: FeedbackRating,
  note?: string,
) {
  return browserApiFetch<{ ok: true }>(
    `/conversations/${conversationId}/messages/${messageId}/feedback`,
    { method: "POST", json: { rating, note: note || undefined } },
  );
}

export function clearAnswerRating(conversationId: string, messageId: string) {
  return browserApiFetch<{ ok: true }>(
    `/conversations/${conversationId}/messages/${messageId}/feedback`,
    { method: "DELETE" },
  );
}

export type SendTemplateResult = SendReplyResult & { text: string };

export function sendTemplateMessage(
  conversationId: string,
  templateId: string,
  values: string[],
  clientMessageId: string,
) {
  return browserApiFetch<SendTemplateResult>(
    `/conversations/${conversationId}/template-messages`,
    { method: "POST", json: { templateId, values, clientMessageId } },
  );
}
