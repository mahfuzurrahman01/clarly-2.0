import { apiFetch, browserApiFetch } from "./client";

export type AppRole = "admin" | "agent";

export type TeamMemberRecord = {
  userId: string;
  email: string;
  appRole: AppRole;
};

export type RemoveTeamMemberResult = {
  /** Unresolved tickets the removed member held, released back to OPEN. */
  releasedTickets: number;
};

export type TeamInviteResult = {
  userId: string;
  email: string;
  appRole: AppRole;
  /** False under a no-op provisioning provider — recorded, but no email sent. */
  invited: boolean;
};

/** Pass `token` from a server component; omit it in the browser. Admin-only. */
export function listTeam(token?: string) {
  const path = "/onboarding/team";
  return token
    ? apiFetch<TeamMemberRecord[]>(path, { token })
    : browserApiFetch<TeamMemberRecord[]>(path);
}

// --- Mutations (browser only — driven by user actions) ---

export function inviteTeamMember(email: string, appRole: AppRole) {
  return browserApiFetch<TeamInviteResult>("/onboarding/team/invite", {
    method: "POST",
    json: { email, appRole },
  });
}

export function changeTeamRole(userId: string, appRole: AppRole) {
  return browserApiFetch<TeamMemberRecord>(`/onboarding/team/${userId}`, {
    method: "PATCH",
    json: { appRole },
  });
}

export function removeTeamMember(userId: string) {
  return browserApiFetch<RemoveTeamMemberResult>(`/onboarding/team/${userId}`, {
    method: "DELETE",
  });
}
