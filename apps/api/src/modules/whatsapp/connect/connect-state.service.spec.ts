import jwt from 'jsonwebtoken';
import type { AppConfigService } from '../../core';
import {
  ConnectStateService,
  InvalidConnectStateError,
} from './connect-state.service';

const SECRET = 'connect-state-secret';

function makeConfig(secret = SECRET): AppConfigService {
  return { whatsappConnectStateSecret: secret } as AppConfigService;
}

describe('ConnectStateService', () => {
  it('signs a state that verify() decodes back to the same tenantId', () => {
    const service = new ConnectStateService(makeConfig());
    const state = service.sign('tenant-1');

    expect(service.verify(state)).toEqual({ tenantId: 'tenant-1' });
  });

  it('rejects an undefined state', () => {
    const service = new ConnectStateService(makeConfig());
    expect(() => service.verify(undefined)).toThrow(InvalidConnectStateError);
  });

  it('rejects a state signed with a different secret (CSRF forgery attempt)', () => {
    const forged = jwt.sign({ tenantId: 'tenant-1' }, 'wrong-secret', {
      algorithm: 'HS256',
    });
    const service = new ConnectStateService(makeConfig());
    expect(() => service.verify(forged)).toThrow(InvalidConnectStateError);
  });

  it('rejects an expired state', () => {
    const expired = jwt.sign({ tenantId: 'tenant-1' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    const service = new ConnectStateService(makeConfig());
    expect(() => service.verify(expired)).toThrow(InvalidConnectStateError);
  });

  it('rejects a well-signed token with no tenantId payload', () => {
    const malformed = jwt.sign({ somethingElse: true }, SECRET, {
      algorithm: 'HS256',
    });
    const service = new ConnectStateService(makeConfig());
    expect(() => service.verify(malformed)).toThrow(InvalidConnectStateError);
  });

  it('rejects tampered garbage', () => {
    const service = new ConnectStateService(makeConfig());
    expect(() => service.verify('not-a-jwt')).toThrow(InvalidConnectStateError);
  });
});
