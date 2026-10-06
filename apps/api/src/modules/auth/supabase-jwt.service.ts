// Auth (AuthModule): verifies a Supabase Auth JWT and extracts the
// TenantAuthContext (T7). This is the ONLY place in the app that decides
// "is this token valid" — everything downstream (TenantAuthMiddleware,
// eventually per-route guards in Feature 2/6) trusts its output rather than
// re-deriving trust from the raw token.
//
// Two signing schemes are accepted, chosen by the token's own `alg` header:
//
//   HS256 — the legacy shared-secret scheme (`SUPABASE_JWT_SECRET`). Still
//     what older Supabase projects issue, and what the local smoke-test
//     tooling mints.
//   ES256/RS256 — asymmetric JWT signing keys, which is what current
//     Supabase (including the local `supabase start` stack) issues. The
//     public key is fetched from the project's JWKS endpoint and cached by
//     `jose` (which also handles kid-miss refetch with its own cooldown).
//
// Reading `alg` off an unverified header is only safe because each branch
// pins the algorithms it will accept: an attacker who rewrites `alg` merely
// picks which verifier rejects them. `alg: none` matches neither branch's
// allowlist and is refused outright.
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../core';
import {
  freshSignupJwtClaimsSchema,
  supabaseJwtClaimsSchema,
  type FreshSignupAuthContext,
  type TenantAuthContext,
} from './jwt-claims';

const ASYMMETRIC_ALGORITHMS = ['ES256', 'RS256'] as const;

@Injectable()
export class SupabaseJwtService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(private readonly config: AppConfigService) {}

  /**
   * Verifies signature + expiry, then validates claim shape. Throws
   * UnauthorizedException with a single generic message on every failure
   * mode (bad signature, expired, malformed, missing tenant_id) — never
   * echoes the underlying library's specific failure reason back to the
   * caller, which would hand an attacker a free oracle for probing token
   * validity.
   */
  async verify(token: string): Promise<TenantAuthContext> {
    const decoded = await this.verifySignature(token);

    const parsed = supabaseJwtClaimsSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return {
      userId: parsed.data.sub,
      tenantId: parsed.data.app_metadata.tenant_id,
      role: parsed.data.role,
      appRole: parsed.data.app_metadata.app_role,
    };
  }

  /**
   * Feature 6's signup path ONLY — verifies signature + expiry and
   * extracts `sub`, deliberately without requiring `app_metadata.
   * tenant_id` (a freshly-signed-up user's token has none yet; assigning
   * it is what the signup endpoint does). Never use this for any
   * route that expects an already-provisioned tenant — `verify()` above
   * is what every other caller (TenantAuthMiddleware included) must keep
   * using.
   */
  async verifyFreshSignup(token: string): Promise<FreshSignupAuthContext> {
    const decoded = await this.verifySignature(token);

    const parsed = freshSignupJwtClaimsSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return {
      userId: parsed.data.sub,
      existingTenantId: parsed.data.app_metadata?.tenant_id,
    };
  }

  private async verifySignature(token: string): Promise<unknown> {
    try {
      const { alg } = decodeProtectedHeader(token);

      if (alg === 'HS256') {
        return jwt.verify(token, this.config.supabaseJwtSecret, {
          algorithms: ['HS256'],
        });
      }

      const { payload } = await jwtVerify(token, this.getJwks(), {
        algorithms: [...ASYMMETRIC_ALGORITHMS],
      });
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Built lazily and memoised: `createRemoteJWKSet` does no I/O until first
   * use, but `SUPABASE_URL` is legitimately empty when tenant provisioning
   * is off, and an empty URL must fail as an auth rejection at request time
   * rather than a boot crash.
   */
  private getJwks(): ReturnType<typeof createRemoteJWKSet> {
    this.jwks ??= createRemoteJWKSet(
      new URL(
        `${this.config.supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
      ),
    );
    return this.jwks;
  }
}
