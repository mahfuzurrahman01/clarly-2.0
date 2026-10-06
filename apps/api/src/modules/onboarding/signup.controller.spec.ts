import type { FreshSignupAuthContext } from '../auth/jwt-claims';
import { SignupController } from './signup.controller';
import type { TenantProvisioningResult } from './tenant-provisioning.dto';
import type { TenantProvisioningService } from './tenant-provisioning.service';

describe('SignupController', () => {
  it('forwards userId, tenantName, and existingTenantId to TenantProvisioningService', async () => {
    const provisioning = { signUp: jest.fn() };
    const controller = new SignupController(
      provisioning as unknown as TenantProvisioningService,
    );
    const result: TenantProvisioningResult = {
      tenantId: 'tenant-1',
      tenantName: 'Acme',
      claimsAssigned: false,
    };
    provisioning.signUp.mockResolvedValue(result);
    const auth: FreshSignupAuthContext = { userId: 'user-1' };

    await expect(controller.signUp(auth, { tenantName: 'Acme' })).resolves.toBe(
      result,
    );
    expect(provisioning.signUp).toHaveBeenCalledWith(
      'user-1',
      'Acme',
      undefined,
    );
  });
});
