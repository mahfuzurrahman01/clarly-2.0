// OnboardingModule (Feature 6): the real TenantAuthProvisioningPort
// binding — calls Supabase's Auth Admin API to set app_metadata on the
// signing-up user. Selected at runtime when
// AppConfigService.tenantProvisioningProvider === 'supabase' (see
// onboarding.module.ts's factory) — but, like NoopProvisioningAdapter,
// this class is ALWAYS constructed by Nest regardless of which one the
// factory picks (both are `inject` dependencies of that factory), so the
// Supabase client itself must be built lazily, on first real use, not in
// the constructor — `createClient()` can throw on an empty/invalid URL,
// and `supabaseUrl`/`supabaseServiceRoleKey` are legitimately empty
// strings under the default 'none' provider. The service-role key this
// needs is exactly the kind of credential that must never be a
// placeholder (CLAUDE.md's secret-management rule), so there's no "real
// adapter with a fake key" middle ground the way DeepSeek's addendum had.
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppConfigService } from '../../core';
import type { AppRole } from '../../auth/jwt-claims';
import {
  TenantAuthProvisioningPort,
  type TeamMember,
  type TeamMemberInviteResult,
} from './tenant-auth-provisioning.port';

/**
 * Re-throws a Supabase Admin API failure as the right kind of error.
 *
 * The SDK's `AuthError` carries the provider's own HTTP status (400 for a
 * rejected email, 429 for its rate limit, etc.) — that status describes the
 * caller's request, not a failure of this service, so it belongs in an
 * `HttpException` Nest can render as-is rather than a generic `Error` that
 * Nest's default filter flattens into an opaque 500. A status outside the
 * 4xx range (network blip, Supabase-side outage) still becomes a plain
 * `Error`, which is what surfaces as 500 — correctly, since that really is
 * this service failing, not the caller.
 */
function toHttpError(message: string, cause: unknown): Error {
  const status =
    cause && typeof cause === 'object' && 'status' in cause
      ? cause.status
      : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new HttpException(message, status);
  }
  return new Error(message);
}

@Injectable()
export class SupabaseAdminProvisioningAdapter extends TenantAuthProvisioningPort {
  private readonly logger = new Logger(SupabaseAdminProvisioningAdapter.name);
  private client: SupabaseClient | undefined;

  constructor(private readonly config: AppConfigService) {
    super();
  }

  private getClient(): SupabaseClient {
    this.client ??= createClient(
      this.config.supabaseUrl,
      this.config.supabaseServiceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    return this.client;
  }

  /**
   * Filtered client-side on `app_metadata.tenant_id`, because the Admin API
   * has no server-side metadata filter. Bounded to the first page: a support
   * team is tens of people, and silently paging through an entire auth
   * instance to build a dropdown would be a worse failure than a short list.
   * If a tenant ever outgrows this, the fix is a members table, not a bigger
   * page.
   */
  async listTeamMembers(tenantId: string): Promise<TeamMember[]> {
    const { data, error } = await this.getClient().auth.admin.listUsers({
      perPage: 200,
    });
    if (error) {
      throw new Error(
        `SupabaseAdminProvisioningAdapter: failed to list team members: ${error.message}`,
      );
    }

    return data.users
      .filter((user) => user.app_metadata?.tenant_id === tenantId)
      .map((user) => ({
        userId: user.id,
        email: user.email ?? '',
        appRole: (user.app_metadata?.app_role as AppRole) ?? 'agent',
      }));
  }

  async findAssignedTenantId(userId: string): Promise<string | undefined> {
    const { data, error } =
      await this.getClient().auth.admin.getUserById(userId);
    if (error) {
      // A user the Admin API can't find belongs to no tenant, by this
      // port's own contract (see the abstract method's doc comment) — not
      // a failure worth 500ing signup over.
      if (error.status === 404) {
        return undefined;
      }
      throw new Error(
        `SupabaseAdminProvisioningAdapter: failed to read user ${userId}: ${error.message}`,
      );
    }
    // `app_metadata` is typed as an index signature of `any` by the
    // Supabase SDK, so the claim is narrowed here rather than trusted.
    const claims = data.user?.app_metadata as
      { tenant_id?: unknown } | undefined;
    const tenantId = claims?.tenant_id;
    return typeof tenantId === 'string' && tenantId ? tenantId : undefined;
  }

  async assignTenantClaims(
    userId: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<void> {
    const { error } = await this.getClient().auth.admin.updateUserById(userId, {
      app_metadata: { tenant_id: tenantId, app_role: appRole },
    });
    if (error) {
      throw new Error(
        `SupabaseAdminProvisioningAdapter: failed to assign claims to user ${userId}: ${error.message}`,
      );
    }
  }

  /**
   * Nulls both claims rather than deleting the user. `tenant_id: null` is
   * what actually ends the membership — TenantAuthMiddleware has no tenant
   * to bind the request to, so the next request from an existing session
   * fails closed even though the JWT itself is still valid until it
   * expires. Callers must treat removal as effective within one token
   * lifetime, not instantly.
   */
  async revokeTenantClaims(userId: string): Promise<void> {
    const { error } = await this.getClient().auth.admin.updateUserById(userId, {
      app_metadata: { tenant_id: null, app_role: null },
    });
    if (error) {
      throw new Error(
        `SupabaseAdminProvisioningAdapter: failed to revoke claims for user ${userId}: ${error.message}`,
      );
    }
  }

  /**
   * Two Admin API calls, not one — `inviteUserByEmail()`'s `data` option
   * maps to `user_metadata`, not `app_metadata` (confirmed against
   * supabase-js's own source/JSDoc), so the tenant/role claim still has
   * to go through the same `updateUserById()` call `assignTenantClaims()`
   * uses, once the invite has produced a real user id to target.
   */
  async inviteTeamMember(
    email: string,
    tenantId: string,
    appRole: AppRole,
  ): Promise<TeamMemberInviteResult> {
    const { data, error } =
      await this.getClient().auth.admin.inviteUserByEmail(email);
    if (error || !data.user) {
      const detail = error?.message ?? 'no user returned';
      this.logger.warn(
        `SupabaseAdminProvisioningAdapter: failed to invite ${email}: ${detail}`,
      );
      // User-facing message omits the adapter class name and internal
      // framing — the detailed version above is for server logs only.
      throw toHttpError(`Couldn't invite ${email}: ${detail}`, error);
    }

    await this.assignTenantClaims(data.user.id, tenantId, appRole);

    return { userId: data.user.id, invited: true };
  }
}
