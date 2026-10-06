import 'reflect-metadata';
import type { AppRole } from './jwt-claims';
import { Roles, ROLES_KEY } from './roles.decorator';

describe('Roles decorator', () => {
  it('stores the given roles under ROLES_KEY, readable via Reflect metadata', () => {
    class Target {
      @Roles('admin', 'agent')
      handler(): void {}
    }

    const roles = Reflect.getMetadata(
      ROLES_KEY,
      // Passed purely as a metadata-lookup key, never invoked unbound.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Target.prototype.handler,
    ) as AppRole[];

    expect(roles).toEqual(['admin', 'agent']);
  });

  it('supports a single role', () => {
    class Target {
      @Roles('admin')
      handler(): void {}
    }

    const roles = Reflect.getMetadata(
      ROLES_KEY,
      // Passed purely as a metadata-lookup key, never invoked unbound.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Target.prototype.handler,
    ) as AppRole[];

    expect(roles).toEqual(['admin']);
  });
});
