// Clarly 2.0 S1 (docs/v2/ARCHITECTURE.md §5): the operator identity.
//
// Deliberately a different shape and a different request property from the
// tenant `auth` context. An operator may have no tenant at all, and a route
// that reads `request.auth.tenantId` must never be able to run for an
// operator by accident; keeping them apart makes that a type error.
import type { PlatformRole } from '../persistence/drizzle/schema';

export interface PlatformAuthContext {
  userId: string;
  email: string;
  role: PlatformRole;
}

declare module 'express' {
  interface Request {
    /** Set only by PlatformAdminGuard, on `/platform/*` routes. */
    platformAuth?: PlatformAuthContext;
  }
}
