// Auth (AuthModule): the Supabase Auth JWT -> TenantContext claim-mapping
// contract (T7). Signature verification alone isn't enough — a
// library-decoded JWT payload is still untrusted input structurally (it's
// attacker-influenced: anyone can mint an unsigned/mis-shaped token and see
// what jwt.verify() does with it before the signature check even runs on a
// malformed payload), so it's schema-validated here per CLAUDE.md's "never
// trust external data" rule.
//
// tenant_id lives under `app_metadata`, NEVER `user_metadata` — Supabase's
// own guidance is that `user_metadata` is end-user-editable (via the
// updateUser API) and therefore unusable for authorization, while
// `app_metadata` is only writable by a service-role key / Auth Hook. See
// docs/decisions/F1-security.md for the full contract and the flagged
// HS256 -> JWKS/ES256 migration path.
//
// T14 (Admin/Agent RBAC): `app_metadata.app_role` is a SEPARATE claim from
// the top-level `role` field above. Supabase's own `role` is a fixed,
// framework-level concept (almost always the literal string
// "authenticated" for any signed-in user, "anon" otherwise) and says
// nothing about product-level permissions. `app_role` is this app's own
// admin/agent distinction, set the same way `tenant_id` is — only via a
// service-role key or Auth Hook when a human agent is provisioned, never
// user-editable. It's optional at the schema level (a token without it
// still passes basic T7 tenant auth) — RolesGuard, not SupabaseJwtService,
// is what fails closed on role-gated routes.
import { z } from 'zod';

export const APP_ROLES = ['admin', 'agent'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const supabaseJwtClaimsSchema = z
  .object({
    sub: z.string().min(1),
    role: z.string().min(1),
    app_metadata: z
      .object({
        tenant_id: z.string().uuid(),
        app_role: z.enum(APP_ROLES).optional(),
      })
      .passthrough(),
    exp: z.number(),
  })
  .passthrough();

export type SupabaseJwtClaims = z.infer<typeof supabaseJwtClaimsSchema>;

/** The subset of the claim actually consumed downstream — keeps callers off the raw JWT payload shape. */
export interface TenantAuthContext {
  userId: string;
  tenantId: string;
  role: string;
  /** App-level admin/agent distinction (T14) — undefined if not provisioned yet; RolesGuard fails closed on this, not SupabaseJwtService. */
  appRole?: AppRole;
}

// Feature 6 (OnboardingModule): a freshly-signed-up Supabase Auth user's
// JWT has no app_metadata.tenant_id yet — that's the entire point of the
// signup endpoint, which is what assigns it. `supabaseJwtClaimsSchema`
// above requires tenant_id, so it correctly rejects a fresh-signup token
// — but that means the signup endpoint itself needs a DIFFERENT, narrower
// verification path: signature + expiry + `sub` only, deliberately NOT
// going through TenantAuthMiddleware (which calls the full schema and
// would 401 before the handler ever runs). Used ONLY by
// SupabaseJwtService.verifyFreshSignup() / SignupController — every other
// route keeps using the full schema.
export const freshSignupJwtClaimsSchema = z
  .object({
    sub: z.string().min(1),
    exp: z.number(),
    // Optional, unlike the full schema — deliberately captured (not just
    // ignored via passthrough) so SignupController can reject a caller
    // who already has a tenant instead of silently minting a second one
    // and overwriting their claims.
    app_metadata: z
      .object({ tenant_id: z.string().uuid().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface FreshSignupAuthContext {
  userId: string;
  /** Set only if this token already carries a tenant_id — a signal the caller has already been provisioned, not an invitation to reuse it for anything else. */
  existingTenantId?: string;
}
