// Clarly 2.0 S1: the gate in front of every `/platform/*` route.
//
// 1. The bearer token must be a valid Supabase session (signature + expiry).
//    `verifyFreshSignup()` is used because an operator's token need not carry
//    a tenant claim; it checks exactly signature, expiry and `sub`.
// 2. `sub` must be in `platform_admins`. Nothing in the JWT (tenant role,
//    app_metadata) can make someone an operator — only that row can.
// 3. If the handler names roles with @PlatformRoles, the operator's role must
//    be one of them.
//
// Every failure before step 2 is a 401; a valid user who is not an operator,
// or an operator with the wrong role, is a 403 with a generic message, so the
// guard never confirms which accounts are operators.
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PlatformRole } from '../persistence/drizzle/schema';
import { SupabaseJwtService } from '../auth/supabase-jwt.service';
import { PlatformAdminService } from './platform-admin.service';
import { PLATFORM_ROLES_KEY } from './platform-roles.decorator';
import './platform-auth';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly jwtService: SupabaseJwtService,
    private readonly admins: PlatformAdminService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const { userId } = await this.jwtService.verifyFreshSignup(
      header.slice(BEARER_PREFIX.length),
    );

    const admin = await this.admins.findByUserId(userId);
    if (!admin) {
      throw new ForbiddenException('Not a platform operator');
    }

    const required = this.reflector.getAllAndOverride<
      PlatformRole[] | undefined
    >(PLATFORM_ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (required && required.length > 0 && !required.includes(admin.role)) {
      throw new ForbiddenException('Insufficient platform role');
    }

    request.platformAuth = {
      userId: admin.userId,
      email: admin.email,
      role: admin.role,
    };
    return true;
  }
}
