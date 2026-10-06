import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AppRole, TenantAuthContext } from './jwt-claims';
import { RolesGuard } from './roles.guard';

function makeContext(auth?: TenantAuthContext): ExecutionContext {
  const request = { auth } as Request;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
  } as unknown as ExecutionContext;
}

function makeGuard(requiredRoles: AppRole[] | undefined): {
  guard: RolesGuard;
} {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  } as unknown as Reflector;
  return { guard: new RolesGuard(reflector) };
}

describe('RolesGuard', () => {
  it('allows the request through when the route has no @Roles() metadata', () => {
    const { guard } = makeGuard(undefined);

    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('allows the request through when @Roles() is an empty array', () => {
    const { guard } = makeGuard([]);

    expect(guard.canActivate(makeContext(undefined))).toBe(true);
  });

  it('allows a caller whose appRole is in the required list', () => {
    const { guard } = makeGuard(['admin']);
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
      appRole: 'admin',
    };

    expect(guard.canActivate(makeContext(auth))).toBe(true);
  });

  it('allows a caller whose appRole matches one of several required roles', () => {
    const { guard } = makeGuard(['admin', 'agent']);
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
      appRole: 'agent',
    };

    expect(guard.canActivate(makeContext(auth))).toBe(true);
  });

  it('throws ForbiddenException when appRole is missing', () => {
    const { guard } = makeGuard(['admin']);
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
    };

    expect(() => guard.canActivate(makeContext(auth))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when req.auth itself is missing (guard used without TenantAuthMiddleware ahead of it — fails closed)', () => {
    const { guard } = makeGuard(['admin']);

    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('throws ForbiddenException when appRole is present but not in the required list (agent hitting an admin-only route)', () => {
    const { guard } = makeGuard(['admin']);
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
      appRole: 'agent',
    };

    expect(() => guard.canActivate(makeContext(auth))).toThrow(
      ForbiddenException,
    );
  });
});
