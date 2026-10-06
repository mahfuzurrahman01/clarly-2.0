import { apiFetch, browserApiFetch } from "./client";

export type TenantProvisioningResult = {
  tenantId: string;
  tenantName: string;
  claimsAssigned: boolean;
};

/**
 * Turn a brand-new Supabase user into a tenant admin. Must be called with the
 * fresh signup token (no tenant_id yet). After this succeeds the caller MUST
 * refresh their Supabase session so the new tenant_id/app_role claims land in
 * the token before hitting any tenant-scoped endpoint.
 */
export type TenantVertical = "commerce" | "services" | "hybrid";
export type TenantLocale = "ar" | "en" | "bn";

export type TenantDirectoryEntry = {
  id: string;
  name: string;
  /** v2: what kind of business this workspace is. */
  vertical: TenantVertical;
  /** v2: ISO 3166-1 alpha-2, or null when not set. */
  country: string | null;
  /** v2: ISO 4217, or null when not set. */
  currency: string | null;
  /** v2: the console language new team members start in. */
  defaultLocale: TenantLocale;
};

export type TenantProfilePatch = Partial<{
  name: string;
  vertical: TenantVertical;
  country: string | null;
  currency: string | null;
  defaultLocale: TenantLocale;
}>;

/** v2 S1: update the workspace profile. Admin-only. Browser-side. */
export function updateTenantProfile(patch: TenantProfilePatch) {
  return browserApiFetch<TenantDirectoryEntry>("/onboarding/tenant/profile", {
    method: "PATCH",
    json: patch,
  });
}

/** The caller's own workspace. Callable by both admin and agent. */
export function getTenant(token: string) {
  return apiFetch<TenantDirectoryEntry>("/onboarding/tenant", { token });
}

export function provisionTenant(token: string, tenantName: string) {
  return apiFetch<TenantProvisioningResult>("/onboarding/signup", {
    method: "POST",
    token,
    json: { tenantName },
  });
}

export type TenantClosureRecord = {
  tenantId: string;
  closedAt: string | null;
  purgeAfter: string | null;
};

/** Close (offboard) the workspace. Admin-only. Browser-side. */
export function closeTenant() {
  return browserApiFetch<TenantClosureRecord>("/onboarding/tenant", {
    method: "DELETE",
  });
}

/** Reopen a closed workspace within the grace period. Admin-only. Browser-side. */
export function reopenTenant() {
  return browserApiFetch<TenantClosureRecord>("/onboarding/tenant/reopen", {
    method: "POST",
  });
}

/** Check closure status. Returns null if the workspace is open. Server-side. */
export function getClosureStatus(token: string) {
  return apiFetch<TenantClosureRecord | null>("/onboarding/tenant/closure", {
    token,
  });
}
