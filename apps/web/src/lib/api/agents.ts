import { apiFetch, browserApiFetch } from "./client";

export type AgentStatus = "draft" | "published" | "archived";
export const AGENT_TONES = ["formal", "friendly", "concise", "warm"] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

export const ESCALATION_TRIGGERS = [
  "negative_sentiment",
  "repeat_question",
  "refund_request",
  "order_change",
  "complaint",
] as const;
export type OptionalEscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export const INTAKE_FIELD_TYPES = [
  "text",
  "number",
  "email",
  "date",
  "choice",
] as const;
export type IntakeFieldType = (typeof INTAKE_FIELD_TYPES)[number];
export type IntakeScope = "conversation" | "customer";
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type IntakeField = {
  key: string;
  label: string;
  type: IntakeFieldType;
  required: boolean;
  choices?: string[];
  scope: IntakeScope;
};

export type DayHours = { open: string; close: string };
export type BusinessHours = Partial<Record<Weekday, DayHours>>;

/**
 * The resolved config a GET returns — every field present (nullable, not
 * optional). Round-trip the whole object on save: a PATCH replaces the config,
 * so preserving untouched fields means sending them back as-is.
 */
export type AgentConfig = {
  intakeFields: IntakeField[];
  roleDescription: string | null;
  persona: string | null;
  tone: AgentTone | null;
  languages: string[];
  greeting: string | null;
  outOfScopeResponse: string | null;
  forbiddenTopics: string[];
  businessHours: BusinessHours | null;
  timezone: string | null;
  outOfHoursResponse: string | null;
  escalationTriggers: OptionalEscalationTrigger[];
  confidenceThreshold: number;
  rerankEnabled: boolean;
  stuckTicketThresholdMinutes: number;
  handoverAutoReturnMinutes: number;
  maxToolCallsPerTurn: number;
};

/** What a PATCH/POST accepts — every field optional. */
export type AgentConfigInput = Partial<AgentConfig>;

export type AgentSummary = {
  id: string;
  name: string;
  status: AgentStatus;
  whatsappNumberId: string | null;
  /** Version answering customers. Null until first publish. */
  publishedVersion: number | null;
  /** True when edits exist that aren't published — the sandbox tests these. */
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Full record: summary + the config to SHOW (draft if one exists, else published). */
export type AgentRecord = AgentSummary & { config: AgentConfig | null };

export type WhatsappNumberOption = {
  id: string;
  phoneNumberId: string;
  /** Agent already answering on it, if any — surfaces "in use" before a 409. */
  boundAgentId: string | null;
};

export type KnowledgeScopeDocument = {
  id: string;
  filename: string;
  selected: boolean;
};

export type KnowledgeScope = {
  /** True = no docs selected = the agent may use the WHOLE KB (not none). */
  scopedToAll: boolean;
  documents: KnowledgeScopeDocument[];
};

export type AgentVersionSummary = {
  version: number;
  publishedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  config: AgentConfig;
};

/**
 * A real agent turn with no side effects: same retrieval/grounding/guardrails,
 * nothing sent to WhatsApp, nothing recorded. Runs the DRAFT when one exists.
 */
export type SandboxResult = {
  answer: string;
  citedChunkIds: string[];
  confidence: number;
  escalate: boolean;
  escalationReason: string | null;
  testedVersion: "draft" | "published";
  latencyMs: number;
};

// --- Reads (server component passes token; browser omits it) ---

export function listAgents(token?: string) {
  const path = "/agents";
  return token
    ? apiFetch<AgentRecord[]>(path, { token })
    : browserApiFetch<AgentRecord[]>(path);
}

export function getAgent(id: string, token?: string) {
  const path = `/agents/${id}`;
  return token
    ? apiFetch<AgentRecord>(path, { token })
    : browserApiFetch<AgentRecord>(path);
}

export function listNumbers(token?: string) {
  const path = "/agents/numbers";
  return token
    ? apiFetch<WhatsappNumberOption[]>(path, { token })
    : browserApiFetch<WhatsappNumberOption[]>(path);
}

export function getKnowledgeScope(id: string, token?: string) {
  const path = `/agents/${id}/knowledge`;
  return token
    ? apiFetch<KnowledgeScope>(path, { token })
    : browserApiFetch<KnowledgeScope>(path);
}

export function listVersions(id: string, token?: string) {
  const path = `/agents/${id}/versions`;
  return token
    ? apiFetch<AgentVersionSummary[]>(path, { token })
    : browserApiFetch<AgentVersionSummary[]>(path);
}

// --- Mutations (browser only — driven by user actions) ---

export function createAgent(name: string, config?: AgentConfigInput) {
  return browserApiFetch<AgentRecord>("/agents", {
    method: "POST",
    json: config ? { name, config } : { name },
  });
}

export function updateAgent(
  id: string,
  patch: {
    name?: string;
    config?: AgentConfigInput;
    whatsappNumberId?: string | null;
  },
) {
  return browserApiFetch<AgentRecord>(`/agents/${id}`, {
    method: "PATCH",
    json: patch,
  });
}

export function publishAgent(id: string) {
  return browserApiFetch<AgentRecord>(`/agents/${id}/publish`, {
    method: "POST",
  });
}

export function archiveAgent(id: string) {
  return browserApiFetch<AgentRecord>(`/agents/${id}/archive`, {
    method: "POST",
  });
}

/** Empty `documentIds` means the WHOLE knowledge base, not none. */
export function setKnowledgeScope(id: string, documentIds: string[]) {
  return browserApiFetch<KnowledgeScope>(`/agents/${id}/knowledge`, {
    method: "PUT",
    json: { documentIds },
  });
}

export function sandboxTest(agentId: string, message: string) {
  return browserApiFetch<SandboxResult>(`/agents/${agentId}/sandbox`, {
    method: "POST",
    json: { message },
  });
}
