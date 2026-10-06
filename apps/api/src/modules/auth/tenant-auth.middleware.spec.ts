import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TenantAuthContext } from './jwt-claims';
import type { SupabaseJwtService } from './supabase-jwt.service';
import type { TenantStatusService } from '../tenant-context/tenant-status.service';
import { TenantAuthMiddleware } from './tenant-auth.middleware';

/** Default for these tests: the tenant is open, so the middleware's closure check is a pass-through. Closed-tenant behaviour has its own tests below. */
function openTenantStatus(closed = false) {
  return {
    isClosed: jest.fn().mockResolvedValue(closed),
    invalidate: jest.fn(),
  } as unknown as TenantStatusService;
}

const AUTH: TenantAuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  role: 'authenticated',
};

function makeReq(
  header?: string,
  route: { method?: string; path?: string } = {},
): Request {
  return {
    headers: { authorization: header },
    method: route.method ?? 'GET',
    path: route.path ?? '/kanban/tickets',
  } as unknown as Request;
}

describe('TenantAuthMiddleware', () => {
  it('rejects a request with no Authorization header, before touching JwtService', async () => {
    const verify = jest.fn();
    const jwtService = { verify } as unknown as SupabaseJwtService;
    const tenantContext = { run: jest.fn() } as unknown as TenantContextService;
    const middleware = new TenantAuthMiddleware(
      jwtService,
      tenantContext,
      openTenantStatus(),
    );

    await expect(
      middleware.use(makeReq(undefined), {} as Response, jest.fn()),
    ).rejects.toThrow(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const jwtService = { verify: jest.fn() } as unknown as SupabaseJwtService;
    const tenantContext = { run: jest.fn() } as unknown as TenantContextService;
    const middleware = new TenantAuthMiddleware(
      jwtService,
      tenantContext,
      openTenantStatus(),
    );

    await expect(
      middleware.use(makeReq('Basic abc123'), {} as Response, jest.fn()),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('verifies the bearer token, attaches req.auth, and runs next() inside the tenant context', async () => {
    const verify = jest.fn().mockResolvedValue(AUTH);
    const jwtService = { verify } as unknown as SupabaseJwtService;
    const run = jest.fn((_tenantId: string, fn: () => unknown) => fn());
    const tenantContext = { run } as unknown as TenantContextService;
    const middleware = new TenantAuthMiddleware(
      jwtService,
      tenantContext,
      openTenantStatus(),
    );
    const next = jest.fn();
    const req = makeReq('Bearer a.b.c');

    await middleware.use(req, {} as Response, next);

    expect(verify).toHaveBeenCalledWith('a.b.c');
    expect(req.auth).toEqual(AUTH);
    expect(run).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('propagates SupabaseJwtService failures (e.g. UnauthorizedException) without calling next()', async () => {
    const jwtService = {
      verify: jest
        .fn()
        .mockRejectedValue(
          new UnauthorizedException('Invalid or expired token'),
        ),
    } as unknown as SupabaseJwtService;
    const tenantContext = { run: jest.fn() } as unknown as TenantContextService;
    const middleware = new TenantAuthMiddleware(
      jwtService,
      tenantContext,
      openTenantStatus(),
    );
    const next = jest.fn();

    await expect(
      middleware.use(makeReq('Bearer bad'), {} as Response, next),
    ).rejects.toThrow(UnauthorizedException);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('TenantAuthMiddleware — closed workspace', () => {
  function makeMiddleware(closed: boolean) {
    const next = jest.fn();
    const jwtService = {
      verify: jest.fn().mockResolvedValue(AUTH),
    } as unknown as SupabaseJwtService;
    const tenantContext = {
      run: jest.fn((_t: string, fn: () => unknown) => fn()),
    } as unknown as TenantContextService;
    return {
      middleware: new TenantAuthMiddleware(
        jwtService,
        tenantContext,
        openTenantStatus(closed),
      ),
      next,
    };
  }

  // 403 rather than 401: the token is perfectly valid, so signing in again
  // will not help — the account itself is closed.
  it('refuses a normal request with 403, not 401', async () => {
    const { middleware, next } = makeMiddleware(true);

    await expect(
      middleware.use(makeReq('Bearer t'), {} as Response, next),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(next).not.toHaveBeenCalled();
  });

  // Without this the closure is a trap: blocking every request would block
  // the endpoint that undoes it, and the grace period would exist on paper
  // only.
  it('still allows reopen, or a closed workspace could never be recovered', async () => {
    const { middleware, next } = makeMiddleware(true);

    await middleware.use(
      makeReq('Bearer t', {
        method: 'POST',
        path: '/onboarding/tenant/reopen',
      }),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  it('still allows reading the closure, so an admin can see the deadline', async () => {
    const { middleware, next } = makeMiddleware(true);

    await middleware.use(
      makeReq('Bearer t', {
        method: 'GET',
        path: '/onboarding/tenant/closure',
      }),
      {} as Response,
      next,
    );

    expect(next).toHaveBeenCalled();
  });

  // The allowlist is method-sensitive: reopen is a POST, and a GET on that
  // path must not slip through it.
  it('does not allow the wrong method on an allowlisted path', async () => {
    const { middleware, next } = makeMiddleware(true);

    await expect(
      middleware.use(
        makeReq('Bearer t', {
          method: 'GET',
          path: '/onboarding/tenant/reopen',
        }),
        {} as Response,
        next,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets everything through for an open workspace', async () => {
    const { middleware, next } = makeMiddleware(false);

    await middleware.use(makeReq('Bearer t'), {} as Response, next);

    expect(next).toHaveBeenCalled();
  });
});
