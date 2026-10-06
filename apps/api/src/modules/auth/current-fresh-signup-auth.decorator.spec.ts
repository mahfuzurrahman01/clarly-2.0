import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { currentFreshSignupAuthFactory } from './current-fresh-signup-auth.decorator';
import type { FreshSignupAuthContext } from './jwt-claims';

function makeContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request as Request }),
  } as unknown as ExecutionContext;
}

describe('currentFreshSignupAuthFactory', () => {
  it('returns req.freshSignupAuth when present', () => {
    const auth: FreshSignupAuthContext = { userId: 'user-1' };

    expect(
      currentFreshSignupAuthFactory(
        undefined,
        makeContext({ freshSignupAuth: auth }),
      ),
    ).toBe(auth);
  });

  it('throws UnauthorizedException when req.freshSignupAuth is missing', () => {
    expect(() =>
      currentFreshSignupAuthFactory(undefined, makeContext({})),
    ).toThrow(UnauthorizedException);
  });
});
