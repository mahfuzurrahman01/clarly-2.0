import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { FreshSignupAuthGuard } from './fresh-signup-auth.guard';
import type { SupabaseJwtService } from './supabase-jwt.service';

function makeContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request as Request }),
  } as unknown as ExecutionContext;
}

describe('FreshSignupAuthGuard', () => {
  it('throws UnauthorizedException when the authorization header is absent', async () => {
    const jwtService = { verifyFreshSignup: jest.fn() };
    const guard = new FreshSignupAuthGuard(
      jwtService as unknown as SupabaseJwtService,
    );
    const request: Partial<Request> = { headers: {} };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException when the header is present but not Bearer-prefixed', async () => {
    const jwtService = { verifyFreshSignup: jest.fn() };
    const guard = new FreshSignupAuthGuard(
      jwtService as unknown as SupabaseJwtService,
    );
    const request: Partial<Request> = {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    };

    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('verifies the token and attaches freshSignupAuth to the request', async () => {
    const auth = { userId: 'user-1' };
    const jwtService = { verifyFreshSignup: jest.fn().mockResolvedValue(auth) };
    const guard = new FreshSignupAuthGuard(
      jwtService as unknown as SupabaseJwtService,
    );
    const request: Partial<Request> = {
      headers: { authorization: 'Bearer some-token' },
    };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(jwtService.verifyFreshSignup).toHaveBeenCalledWith('some-token');
    expect(request.freshSignupAuth).toBe(auth);
  });
});
