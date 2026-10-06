// Auth (AuthModule): the sanctioned request-boundary entry point for
// TenantContextService.run() (T7). Deliberately middleware, not a Guard —
// AsyncLocalStorage's run() only keeps its context alive for work
// triggered synchronously from inside the callback passed to it, and a
// Guard's canActivate() returns before the controller handler ever runs,
// so a Guard can't wrap the handler in run(). Middleware's next() *does*
// invoke the rest of the pipeline (further middleware, guards,
// interceptors, controller, and any service calls made from it)
// synchronously from within that same call frame, which is what keeps the
// tenant context alive end-to-end. This is the standard pattern for
// AsyncLocalStorage-based request context in Nest (same approach
// nestjs-cls uses).
//
// Not wired into app.module's global middleware chain yet — there are no
// protected routes until Feature 2 (webhook) / Feature 6 (onboarding
// API). Those modules apply this explicitly via `consumer.apply(...)
// .forRoutes(...)` when their controllers land, per the contract in
// docs/decisions/F1-security.md.
import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantStatusService } from '../tenant-context/tenant-status.service';
import { SupabaseJwtService } from './supabase-jwt.service';

const BEARER_PREFIX = 'Bearer ';

/**
 * The only routes a closed workspace may still reach.
 *
 * Without this the closure is a trap: blocking every request would block the
 * very endpoint that undoes it, so a mistaken close could never be reversed
 * and the grace period would exist on paper only. Reading the closure is
 * allowed for the same reason — an admin has to be able to see when their data
 * is scheduled to go.
 *
 * Matched on the path suffix rather than the full URL so a global prefix or a
 * mount point cannot silently unlock more than intended.
 */
const CLOSED_TENANT_ALLOWED = [
  { method: 'POST', suffix: '/onboarding/tenant/reopen' },
  { method: 'GET', suffix: '/onboarding/tenant/closure' },
] as const;

function isAllowedWhileClosed(method: string, path: string): boolean {
  return CLOSED_TENANT_ALLOWED.some(
    (route) =>
      route.method === method.toUpperCase() && path.endsWith(route.suffix),
  );
}

@Injectable()
export class TenantAuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: SupabaseJwtService,
    private readonly tenantContextService: TenantContextService,
    private readonly tenantStatus: TenantStatusService,
  ) {}

  // Async only because signature verification may need the project's JWKS
  // (asymmetric Supabase signing keys). The AsyncLocalStorage contract is
  // unaffected: what matters is that next() is invoked from *inside* the
  // run() callback, which is still the case after the await.
  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice(BEARER_PREFIX.length);
    const auth = await this.jwtService.verify(token);

    // A closed workspace stops serving immediately, ahead of any handler.
    // Checked here rather than per-controller for the same reason the tenant
    // context is established here: one place, no route can forget it. The
    // lookup is TTL-cached (TenantStatusService), so this is not a database
    // round trip per request.
    //
    // 403 and not 401: the token is perfectly valid: signing in again will not
    // help, because the account itself is closed.
    if (
      !isAllowedWhileClosed(req.method, req.path) &&
      (await this.tenantStatus.isClosed(auth.tenantId))
    ) {
      throw new ForbiddenException(
        'This workspace is closed. An admin can reopen it before its scheduled deletion.',
      );
    }

    // Stash the full auth context (userId/role, not just tenantId) for
    // controllers that need it — TenantContextService only carries
    // tenantId, so anything role-aware reads req.auth directly.
    req.auth = auth;

    void this.tenantContextService.run(auth.tenantId, () => next());
  }
}
