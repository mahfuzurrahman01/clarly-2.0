import { apiFetch, browserApiFetch } from "./client";

export type TemplateKind = "whatsapp_template" | "canned_reply";
export type TemplateCategory = "UTILITY" | "MARKETING" | "AUTHENTICATION";
export type TemplateApprovalStatus =
  | "local"
  | "pending"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled";

export type TemplateVariable = {
  position: number;
  label: string;
  example: string | null;
};

export type MessageTemplateRecord = {
  id: string;
  kind: TemplateKind;
  name: string;
  language: string;
  category: TemplateCategory | null;
  body: string;
  variables: TemplateVariable[];
  approvalStatus: TemplateApprovalStatus;
  approvalDetail: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TemplateSyncResult = {
  updated: number;
  unknownToBsp: string[];
  unreported: boolean;
};

export type TemplateSubmissionResult = {
  submitted: boolean;
  providerTemplateId: string | null;
  unsupportedReason: string | null;
};

export function listTemplates(kind?: TemplateKind, token?: string) {
  const qs = kind ? `?kind=${kind}` : "";
  const path = `/templates${qs}`;
  return token
    ? apiFetch<MessageTemplateRecord[]>(path, { token })
    : browserApiFetch<MessageTemplateRecord[]>(path);
}

export function getTemplate(id: string) {
  return browserApiFetch<MessageTemplateRecord>(`/templates/${id}`);
}

export function previewTemplate(id: string, values: string[]) {
  return browserApiFetch<{ text: string }>(`/templates/${id}/preview`, {
    method: "POST",
    json: { values },
  });
}

// --- Admin mutations ---

export type CreateTemplateInput = {
  kind: TemplateKind;
  name: string;
  language: string;
  category: TemplateCategory | null;
  body: string;
  variables: TemplateVariable[];
};

export function createTemplate(input: CreateTemplateInput) {
  return browserApiFetch<MessageTemplateRecord>("/templates", {
    method: "POST",
    json: input,
  });
}

export type UpdateTemplateInput = Partial<{
  name: string;
  category: TemplateCategory | null;
  body: string;
  variables: TemplateVariable[];
}>;

export function updateTemplate(id: string, input: UpdateTemplateInput) {
  return browserApiFetch<MessageTemplateRecord>(`/templates/${id}`, {
    method: "PATCH",
    json: input,
  });
}

export function deleteTemplate(id: string) {
  return browserApiFetch<{ ok: true }>(`/templates/${id}`, {
    method: "DELETE",
  });
}

export function submitTemplate(id: string) {
  return browserApiFetch<TemplateSubmissionResult>(`/templates/${id}/submit`, {
    method: "POST",
  });
}

export function syncTemplates() {
  return browserApiFetch<TemplateSyncResult>("/templates/sync", {
    method: "POST",
  });
}
