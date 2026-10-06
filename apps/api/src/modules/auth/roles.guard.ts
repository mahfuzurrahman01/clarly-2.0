// Auth (AuthModule): T14 — Admin/Agent RBAC on top of T7's tenant-scoped
// auth. Deliberately a Guard, not middleware (unlike TenantAuthMiddleware):
// role checking doesn't need AsyncLocalStorage's run() semantics, it's a
// pure "does req.auth.appRole satisfy this route's @Roles() metadata"
// check, which is exactly what Guards are for. Runs after
// TenantAuthMiddleware, which is what populates req.auth in the first
// place — a route using RolesGuard without TenantAuthMiddleware applied
// ahead of it fails closed (no req.auth => denied), not open.
//
// A route with no @Roles() decorator is NOT gated by this guard — it's
// treated as "any authenticated human agent, admin or agent, may access
// this," which is T7's baseline. Only routes that explicitly declare
// @Roles(...) get the additional admin/agent restriction, per T14's spec:
// "Agent sees and acts on only their assigned/queue tickets — no
// team/config/policy access" is an allowlist on *specific* endpoints, not
// a default-deny on everything.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppRole } from './jwt-claims';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<
      AppRole[] | undefined
    >(ROLES_KEY, [context.getHandler(), context.getClass()]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const appRole = request.auth?.appRole;

    if (!appRole || !requiredRoles.includes(appRole)) {
      // Same "don't leak specifics" discipline as SupabaseJwtService: one
      // generic message whether the caller has no app_role at all or has
      // the wrong one.
      throw new ForbiddenException('Insufficient role for this action');
    }

    return true;
  }
}
