// Auth (AuthModule): param decorator giving controllers typed access to
// req.auth without reaching into the raw Express Request themselves (and
// without repeating the "throw if somehow missing" guard at every call
// site). A route reaching this decorator with no req.auth means
// TenantAuthMiddleware wasn't applied ahead of it — fail closed rather
// than hand the controller an `undefined` and let it npe deeper in.
//
// The factory is exported separately from the decorator itself so it can
// be unit-tested directly — `createParamDecorator`'s return value can
// only be exercised through Nest's real request pipeline, which would
// otherwise leave this logic branch-uncovered.
import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TenantAuthContext } from './jwt-claims';

export function currentAuthFactory(
  _data: unknown,
  ctx: ExecutionContext,
): TenantAuthContext {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.auth) {
    throw new UnauthorizedException('Missing auth context');
  }
  return request.auth;
}

export const CurrentAuth = createParamDecorator(currentAuthFactory);
