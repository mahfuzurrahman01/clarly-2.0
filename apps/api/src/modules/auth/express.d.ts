// Augments Express's Request with the auth context TenantAuthMiddleware
// attaches. Declared here (not a global d.ts) so the augmentation's
// provenance is obvious — it's AuthModule's contract, not ambient magic.
import type { FreshSignupAuthContext, TenantAuthContext } from './jwt-claims';

declare module 'express' {
  interface Request {
    auth?: TenantAuthContext;
    /** Set only by FreshSignupAuthGuard, on the signup route — see jwt-claims.ts's freshSignupJwtClaimsSchema for why this is a separate, narrower context than `auth`. */
    freshSignupAuth?: FreshSignupAuthContext;
  }
}
