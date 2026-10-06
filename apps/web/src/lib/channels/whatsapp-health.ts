// Presentation for WhatsApp number health (Gulf T5 fields, all optional).
// Values are Meta's enums; anything unrecognised is shown as-is rather than
// hidden, so a new Meta value never silently disappears from the screen.
import type {
  ConnectedWhatsappNumber,
  WhatsappConnectionState,
} from "@/lib/api/whatsapp-connect";
import type { Dictionary } from "@/lib/i18n/get-dictionary";

export type HealthTone = "good" | "warn" | "bad" | "neutral";
export type HealthItem = { key: string; label: string; value: string; tone: HealthTone };

function norm(value: string): string {
  return value.trim().toUpperCase();
}

export function qualityDisplay(value: string, t: Dictionary): { value: string; tone: HealthTone } {
  switch (norm(value)) {
    case "GREEN":
    case "HIGH":
      return { value: t.channels.qualityGreen, tone: "good" };
    case "YELLOW":
    case "MEDIUM":
      return { value: t.channels.qualityYellow, tone: "warn" };
    case "RED":
    case "LOW":
      return { value: t.channels.qualityRed, tone: "bad" };
    case "UNKNOWN":
    case "NA":
      return { value: t.channels.qualityUnknown, tone: "neutral" };
    default:
      return { value, tone: "neutral" };
  }
}

/** TIER_250 → "250 customers / 24h", TIER_10K → "10,000 …", TIER_UNLIMITED → "Unlimited". */
export function messagingLimitDisplay(value: string, t: Dictionary, locale?: string): string {
  const v = norm(value);
  if (v === "TIER_UNLIMITED" || v === "UNLIMITED") return t.channels.limitUnlimited;
  const match = /^TIER_(\d+)(K?)$/.exec(v);
  if (!match) return value;
  const count = Number(match[1]) * (match[2] === "K" ? 1000 : 1);
  return t.channels.limitTemplate.replace("{count}", count.toLocaleString(locale));
}

export function nameStatusDisplay(value: string, t: Dictionary): { value: string; tone: HealthTone } {
  switch (norm(value)) {
    case "APPROVED":
    case "AVAILABLE_WITHOUT_REVIEW":
      return { value: t.channels.nameApproved, tone: "good" };
    case "PENDING_REVIEW":
    case "PENDING":
    case "IN_REVIEW":
      return { value: t.channels.namePending, tone: "warn" };
    case "DECLINED":
    case "REJECTED":
      return { value: t.channels.nameDeclined, tone: "bad" };
    default:
      return { value, tone: "neutral" };
  }
}

/** Only the health facts the payload actually carries (empty before T5 ships). */
export function healthItems(
  number: ConnectedWhatsappNumber,
  t: Dictionary,
  locale?: string,
): HealthItem[] {
  const items: HealthItem[] = [];
  if (number.qualityRating) {
    items.push({ key: "quality", label: t.channels.qualityLabel, ...qualityDisplay(number.qualityRating, t) });
  }
  if (number.messagingLimitTier) {
    items.push({
      key: "limit",
      label: t.channels.limitLabel,
      value: messagingLimitDisplay(number.messagingLimitTier, t, locale),
      tone: "neutral",
    });
  }
  if (number.nameStatus) {
    items.push({ key: "name", label: t.channels.nameStatusLabel, ...nameStatusDisplay(number.nameStatus, t) });
  }
  return items;
}

export function connectionStateLabel(state: WhatsappConnectionState, t: Dictionary): string {
  switch (state) {
    case "active":
      return t.channels.stateActive;
    case "reconnect_required":
      return t.channels.stateReconnectRequired;
    case "restricted":
      return t.channels.stateRestricted;
    case "disconnected":
      return t.channels.stateDisconnected;
  }
}

/** What to tell the admin about a non-active number: the server's sentence first. */
export function connectionProblem(number: ConnectedWhatsappNumber, t: Dictionary): string | null {
  if (number.connectionState === "active") return null;
  if (number.connectionError) return number.connectionError;
  switch (number.connectionState) {
    case "restricted":
      return t.channels.restrictedGeneric;
    case "disconnected":
      return t.channels.disconnectedGeneric;
    default:
      return t.channels.reconnectGeneric;
  }
}
