// Auth (AuthModule): Feature 6's signup-only auth boundary. Deliberately
// NOT TenantAuthMiddleware — that requires app_metadata.tenant_id to
// already exist, which a freshly-signed-up user's token never has (see
// jwt-claims.ts's freshSignupJwtClaimsSchema header comment). A Guard,
// not middleware, since there's no tenant context to establish via
// AsyncLocalStorage yet — same reasoning RolesGuard already documents for
// why it's a Guard and TenantAuthMiddleware isn't.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseJwtService } from './supabase-jwt.service';

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class FreshSignupAuthGuard implements CanActivate {
  constructor(private readonly jwtService: SupabaseJwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const token = header.slice(BEARER_PREFIX.length);
    request.freshSignupAuth = await this.jwtService.verifyFreshSignup(token);
    return true;
  }
}
