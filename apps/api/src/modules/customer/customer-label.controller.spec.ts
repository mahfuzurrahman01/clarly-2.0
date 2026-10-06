// Feature 18: the label read/override HTTP surface.
//
// Launch-integration fix (2026-09-17): PUT/DELETE are entitlement-gated
// (label writes are a "using the product" action, same as ticket
// claim/assign/resolve) — GET stays open, same split as everywhere else
// EntitlementGuard is used.
import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { EntitlementGuard } from '../billing/entitlement.guard';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { CustomerLabelController } from './customer-label.controller';
import type { CustomerLabelRecord } from './customer-label.dto';
import type { CustomerLabelService } from './customer-label.service';
import type { CustomerService } from './customer.service';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const CUSTOMER_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const auth = {
  tenantId: TENANT_A,
  userId: USER_ID,
  appRole: 'agent',
} as TenantAuthContext;

const noopAudit = { describe: jest.fn() };

function makeRecord(
  overrides: Partial<CustomerLabelRecord> = {},
): CustomerLabelRecord {
  return {
    customerId: CUSTOMER_ID,
    label: 'warm',
    source: 'agent',
    overriddenAt: null,
    overriddenBy: null,
    agentLabel: 'warm',
    agentEvaluatedAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeHarness(customerExists = true) {
  const get = jest.fn().mockResolvedValue(makeRecord());
  const override = jest
    .fn()
    .mockResolvedValue(
      makeRecord({ label: 'hot', source: 'human', overriddenBy: USER_ID }),
    );
  const clearOverride = jest.fn().mockResolvedValue(makeRecord());
  const getCustomer = jest
    .fn()
    .mockResolvedValue(customerExists ? { id: CUSTOMER_ID } : null);

  const controller = new CustomerLabelController(
    { get, override, clearOverride } as unknown as CustomerLabelService,
    { getCustomer } as unknown as CustomerService,
  );

  return { controller, get, override, clearOverride, getCustomer };
}

describe('CustomerLabelController', () => {
  it('reads the label for a customer in the calling tenant', async () => {
    const { controller, get } = makeHarness();

    await expect(controller.get(auth, CUSTOMER_ID)).resolves.toMatchObject({
      label: 'warm',
      source: 'agent',
    });
    expect(get).toHaveBeenCalledWith(TENANT_A, CUSTOMER_ID);
  });

  it('overrides the label as the CALLING user, never a client-supplied one', async () => {
    const { controller, override } = makeHarness();

    await controller.override(auth, CUSTOMER_ID, { label: 'hot' }, noopAudit);

    // Same discipline as ticket claim: acting on someone else's behalf is
    // deliberately not expressible in the request.
    expect(override).toHaveBeenCalledWith(
      TENANT_A,
      CUSTOMER_ID,
      'hot',
      USER_ID,
    );
  });

  it('clears the override', async () => {
    const { controller, clearOverride } = makeHarness();

    await controller.clearOverride(auth, CUSTOMER_ID, noopAudit);

    expect(clearOverride).toHaveBeenCalledWith(TENANT_A, CUSTOMER_ID);
  });

  describe("a customer the calling tenant cannot see (another tenant's, or nonexistent)", () => {
    it('404s the read', async () => {
      const { controller } = makeHarness(false);

      await expect(controller.get(auth, CUSTOMER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s the override BEFORE any write happens', async () => {
      const { controller, override } = makeHarness(false);

      await expect(
        controller.override(auth, CUSTOMER_ID, { label: 'hot' }, noopAudit),
      ).rejects.toBeInstanceOf(NotFoundException);
      // The point of checking first: without it, this would insert a label row
      // under the CALLER's tenant pointing at another tenant's customer id.
      expect(override).not.toHaveBeenCalled();
    });

    it('404s the clear before any write happens', async () => {
      const { controller, clearOverride } = makeHarness(false);

      await expect(
        controller.clearOverride(auth, CUSTOMER_ID, noopAudit),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(clearOverride).not.toHaveBeenCalled();
    });
  });

  describe('EntitlementGuard coverage', () => {
    function guardsOn(methodName: keyof CustomerLabelController): unknown[] {
      // The prototype method below is a metadata reflection target, never
      // invoked, so `this` binding does not apply.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const method = CustomerLabelController.prototype[methodName];
      const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, method);
      return Array.isArray(guards) ? (guards as unknown[]) : [];
    }

    it('gates the override (PUT) write', () => {
      expect(guardsOn('override')).toContain(EntitlementGuard);
    });

    it('gates the clearOverride (DELETE) write', () => {
      expect(guardsOn('clearOverride')).toContain(EntitlementGuard);
    });

    it('leaves the read (GET) open', () => {
      expect(guardsOn('get')).not.toContain(EntitlementGuard);
    });
  });
});
