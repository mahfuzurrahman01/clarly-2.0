import { apiFetch, browserApiFetch } from "./client";

/** T4's default — matches the DB column default once a row exists. */
export const DEFAULT_STUCK_TICKET_THRESHOLD_MINUTES = 15;

export type TenantPolicyRecord = {
  tenantId: string;
  confidenceThreshold: number;
  forbiddenTopics: string[];
  tonePersonaOverride: string | null;
  rerankEnabled: boolean;
  stuckTicketThresholdMinutes: number;
};

export type UpsertTenantPolicyInput = {
  stuckTicketThresholdMinutes?: number;
  rerankEnabled?: boolean;
};

/** Pass `token` from a server component; omit it in the browser. Admin-only. `null` means the tenant has never set a policy — running on defaults. */
export function getTenantPolicy(token?: string) {
  const path = "/onboarding/tenant-policy";
  return token
    ? apiFetch<TenantPolicyRecord | null>(path, { token })
    : browserApiFetch<TenantPolicyRecord | null>(path);
}

/**
 * Only ever sends stuckTicketThresholdMinutes/rerankEnabled from this app —
 * the endpoint also accepts confidenceThreshold/forbiddenTopics/
 * tonePersonaOverride, but those are owned by Agent settings (PATCH
 * /agents/:id), which saves as a draft requiring an explicit publish. This
 * endpoint writes through and publishes the tenant's single published agent
 * immediately, so sending agent-owned fields here would silently bypass that
 * review step.
 */
export function upsertTenantPolicy(input: UpsertTenantPolicyInput) {
  return browserApiFetch<TenantPolicyRecord>("/onboarding/tenant-policy", {
    method: "PATCH",
    json: input,
  });
}
