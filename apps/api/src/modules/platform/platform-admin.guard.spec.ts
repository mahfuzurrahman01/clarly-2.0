import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { SupabaseJwtService } from '../auth/supabase-jwt.service';
import type { PlatformRole } from '../persistence/drizzle/schema';
import { PlatformAdminGuard } from './platform-admin.guard';
import type {
  PlatformAdminRecord,
  PlatformAdminService,
} from './platform-admin.service';
import { PLATFORM_ROLES_KEY } from './platform-roles.decorator';

const USER = '22222222-2222-4222-8222-222222222222';

function makeContext(
  headers: Record<string, string>,
  roles?: PlatformRole[],
): { ctx: ExecutionContext; request: Partial<Request>; reflector: Reflector } {
  const request: Partial<Request> = { headers };
  const handler = (): void => undefined;
  const reflector = new Reflector();
  if (roles) Reflect.defineMetadata(PLATFORM_ROLES_KEY, roles, handler);
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
  return { ctx, request, reflector };
}

function makeGuard(
  reflector: Reflector,
  admin: PlatformAdminRecord | null,
  verify: jest.Mock = jest.fn().mockResolvedValue({ userId: USER }),
): PlatformAdminGuard {
  const jwt = { verifyFreshSignup: verify } as unknown as SupabaseJwtService;
  const admins = {
    findByUserId: jest.fn().mockResolvedValue(admin),
  } as unknown as PlatformAdminService;
  return new PlatformAdminGuard(jwt, admins, reflector);
}

const OWNER: PlatformAdminRecord = {
  userId: USER,
  email: 'ops@clarly.test',
  role: 'owner',
  grantedBy: null,
  createdAt: new Date('2026-10-06T00:00:00Z'),
};

describe('PlatformAdminGuard', () => {
  it('rejects a request with no bearer token as 401', async () => {
    const { ctx, reflector } = makeContext({});
    await expect(makeGuard(reflector, OWNER).canActivate(ctx)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('propagates a 401 from token verification', async () => {
    const { ctx, reflector } = makeContext({ authorization: 'Bearer bad' });
    const verify = jest
      .fn()
      .mockRejectedValue(new UnauthorizedException('Invalid or expired token'));
    await expect(
      makeGuard(reflector, OWNER, verify).canActivate(ctx),
    ).rejects.toThrow(UnauthorizedException);
  });

  // The whole point of the table: a valid Supabase user — including a tenant
  // admin of some workspace — is NOT an operator unless the row exists.
  it('rejects a valid user who is not in platform_admins as 403', async () => {
    const { ctx, reflector } = makeContext({ authorization: 'Bearer ok' });
    await expect(makeGuard(reflector, null).canActivate(ctx)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('admits an operator and attaches the platform context', async () => {
    const { ctx, request, reflector } = makeContext({
      authorization: 'Bearer ok',
    });
    await expect(makeGuard(reflector, OWNER).canActivate(ctx)).resolves.toBe(
      true,
    );
    expect(request.platformAuth).toEqual({
      userId: USER,
      email: 'ops@clarly.test',
      role: 'owner',
    });
    // Never the tenant context: an operator route must not look tenant-scoped.
    expect(request.auth).toBeUndefined();
  });

  it('enforces @PlatformRoles when the handler names roles', async () => {
    const { ctx, reflector } = makeContext({ authorization: 'Bearer ok' }, [
      'owner',
    ]);
    await expect(
      makeGuard(reflector, { ...OWNER, role: 'viewer' }).canActivate(ctx),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets any operator role through when no roles are named', async () => {
    const { ctx, reflector } = makeContext({ authorization: 'Bearer ok' });
    await expect(
      makeGuard(reflector, { ...OWNER, role: 'viewer' }).canActivate(ctx),
    ).resolves.toBe(true);
  });
});
