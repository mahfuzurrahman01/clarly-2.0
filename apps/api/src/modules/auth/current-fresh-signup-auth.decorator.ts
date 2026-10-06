// Auth (AuthModule): the FreshSignupAuthGuard-only counterpart to
// CurrentAuth — see that file and jwt-claims.ts's
// freshSignupJwtClaimsSchema for why signup needs a separate context. The
// factory is exported separately for the same direct-unit-test reason
// current-auth.decorator.ts documents.
import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { FreshSignupAuthContext } from './jwt-claims';

export function currentFreshSignupAuthFactory(
  _data: unknown,
  ctx: ExecutionContext,
): FreshSignupAuthContext {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.freshSignupAuth) {
    throw new UnauthorizedException('Missing auth context');
  }
  return request.freshSignupAuth;
}

export const CurrentFreshSignupAuth = createParamDecorator(
  currentFreshSignupAuthFactory,
);
