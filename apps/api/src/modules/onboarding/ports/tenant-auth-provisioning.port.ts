// OnboardingModule (Feature 6): the D1-style provider-portability port for
// Supabase Auth Admin API operations this app needs — assigning
// app_metadata claims (signup) and inviting a brand-new user by email
// (team invite), both of which only a service-role key can perform. Kept
// as a port (not direct adapter calls from the services) for the same
// reason LlmProvider/Embedder are ports: a vendor swap or a test double is
// a binding change, never a call-site change.
import type { AppRole } from '../../auth/jwt-claims';

export interface TeamMemberInviteResult {
  userId: string;
  /** False under NoopProvisioningAdapter (no real Supabase project) — nothing was actually emailed. */
  invited: boolean;
}

/** A person who can be assigned a ticket. Identity only — this port never exposes anything but what a picker needs to show. */
export interface TeamMember {
  userId: string;
  email: string;
  appRole: AppRole;
}

export abstract class TenantAuthProvisioningPort {
  /**
   * Everyone whose claims put them in this tenant.
   *
   * Users live in Supabase auth, not in this database, so there is no table
   * to join against — a directory has to come from the auth provider or not
   * at all. Returns an empty list rather than throwing when the provider
   * cannot answer: a ticket board that still works without a picker beats a
   * board that will not load.
   */
  abstract listTeamMembers(tenantId: string): Promise<TeamMember[]>;

  /**
   * The tenant this user is currently provisioned into, straight from the
   * auth provider — `undefined` when they belong to none, or when the
   * provider cannot answer (the no-op adapter, which has no directory).
   *
   * Signup needs this because a JWT is a snapshot: a user who signed up
   * five minutes ago still holds a token minted before their claims were
   * written, and that token says they have no tenant. Trusting it lets the
   * same person sign up repeatedly, minting a fresh workspace each time and
   * repointing their own claims at the newest one — every earlier workspace
   * is then orphaned with its data and no way back in.
   */
  abstract findAssignedTenantId(userId: string): Promise<string | undefined>;

  abstract assignTenantClaims(
    userId: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<void>;

  /**
   * Removes a user from the tenant by clearing the claims that put them in
   * it. Deliberately not "delete the user": the same person may belong to
   * another workspace, or sign up again later, and destroying an auth
   * identity to end a workspace membership is a much larger action than the
   * admin asked for.
   */
  abstract revokeTenantClaims(userId: string): Promise<void>;

  /** Creates (or re-invites) a Supabase Auth user by email and assigns them straight into the given tenant with the given role — the admin/agent counterpart of signUp() for a user who doesn't exist yet. */
  abstract inviteTeamMember(
    email: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<TeamMemberInviteResult>;
}
