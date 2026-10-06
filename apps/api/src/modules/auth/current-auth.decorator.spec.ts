import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { currentAuthFactory } from './current-auth.decorator';
import type { TenantAuthContext } from './jwt-claims';

function makeContext(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request as Request }),
  } as unknown as ExecutionContext;
}

describe('currentAuthFactory', () => {
  it('returns req.auth when present', () => {
    const auth: TenantAuthContext = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'authenticated',
    };

    expect(currentAuthFactory(undefined, makeContext({ auth }))).toBe(auth);
  });

  it('throws UnauthorizedException when req.auth is missing', () => {
    expect(() => currentAuthFactory(undefined, makeContext({}))).toThrow(
      UnauthorizedException,
    );
  });
});
