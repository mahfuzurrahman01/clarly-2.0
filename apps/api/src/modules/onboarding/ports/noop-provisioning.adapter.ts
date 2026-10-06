// OnboardingModule (Feature 6): bound when TENANT_PROVISIONING_PROVIDER
// is 'none' (the default — no Supabase project provisioned in this
// environment), same "real no-op adapter, never a placeholder
// credential" pattern as NoopRerankerAdapter (RetrievalModule, D4).
// Signup still works end to end — the tenant row is created for real —
// this just can't reach out to a real Supabase Auth Admin API to write
// app_metadata, so it logs clearly what it would have done instead of
// pretending to succeed silently.
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../../core';
import type { AppRole } from '../../auth/jwt-claims';
import {
  TenantAuthProvisioningPort,
  type TeamMemberInviteResult,
  type TeamMember,
} from './tenant-auth-provisioning.port';

@Injectable()
export class NoopProvisioningAdapter extends TenantAuthProvisioningPort {
  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  /**
   * Always `undefined`: with no auth provider there is no directory to read,
   * so signup falls back to the token's own claim. That is the same posture
   * every other method here takes — answer honestly that nothing is known
   * rather than invent a record.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async findAssignedTenantId(): Promise<string | undefined> {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async assignTenantClaims(
    userId: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<void> {
    this.logger.warn(
      `NoopProvisioningAdapter: no real Supabase project configured (TENANT_PROVISIONING_PROVIDER=none) — ` +
        `would have set app_metadata.tenant_id=${tenantId}, app_role=${appRole} for user ${userId}. ` +
        `The tenant row was still created for real; this user's JWT will not carry the new claims until ` +
        `TENANT_PROVISIONING_PROVIDER=supabase is configured and the claim is set through the real Admin API.`,
      'NoopProvisioningAdapter',
    );
  }

  /** No auth provider to ask, so no directory. Empty rather than thrown: the board must still work without a picker. */
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async listTeamMembers(): Promise<TeamMember[]> {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async revokeTenantClaims(userId: string): Promise<void> {
    this.logger.warn(
      `NoopProvisioningAdapter: no real Supabase project configured (TENANT_PROVISIONING_PROVIDER=none) — ` +
        `would have cleared app_metadata.tenant_id/app_role for user ${userId}. That user's real claims are ` +
        `unchanged, so they keep whatever access they had.`,
      'NoopProvisioningAdapter',
    );
  }

  /** Fabricates a userId rather than leaving it blank/null — callers (TeamInviteService) still need something shaped like a real Supabase user id to return in the API response, even though no real user was created and nobody was emailed. */
  // eslint-disable-next-line @typescript-eslint/require-await -- no network call; async to satisfy the port contract.
  async inviteTeamMember(
    email: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<TeamMemberInviteResult> {
    const fakeUserId = randomUUID();
    this.logger.warn(
      `NoopProvisioningAdapter: no real Supabase project configured (TENANT_PROVISIONING_PROVIDER=none) — ` +
        `would have invited ${email} to tenant ${tenantId} as ${appRole}. No email was actually sent; ` +
        `fabricated userId=${fakeUserId} is not a real Supabase Auth user.`,
      'NoopProvisioningAdapter',
    );
    return { userId: fakeUserId, invited: false };
  }
}
