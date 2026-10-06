import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PlatformAuthContext } from './platform-auth';

export function currentPlatformAuthFactory(
  _data: unknown,
  ctx: ExecutionContext,
): PlatformAuthContext {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.platformAuth) {
    throw new UnauthorizedException('Missing platform auth context');
  }
  return request.platformAuth;
}

export const CurrentPlatformAuth = createParamDecorator(
  currentPlatformAuthFactory,
);
