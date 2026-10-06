// F25 D9: "controller specs, one per endpoint, no exceptions."
//
// F20 shipped two P1s that no service-level test could have seen — a literal
// route shadowed by `/:id`, and a write endpoint with no schema on its body —
// so the assertions here are deliberately about the HTTP boundary itself:
// route paths, guards, status codes and the validation schemas, not about what
// the services do underneath.
import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { InvalidOrderTransitionFilter } from './invalid-order-transition.filter';
import type { OrderApprovalService } from './order-approval.service';
import { OrderController } from './order.controller';
import { OrderSettingsController } from './order-settings.controller';
import type { OrderSettingsService } from './order-settings.service';
import type { OrderToolSeederService } from './order-tool-seeder.service';
import type { OrderService } from './order.service';
import {
  listOrdersQuerySchema,
  rejectOrderBodySchema,
  updateOrderSettingsSchema,
  type OrderView,
} from './order.dto';
import { InvalidOrderTransitionError } from './order-status-transition';
import { recordingAudit } from '../audit/__fixtures__/recording-audit';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const auth = {
  tenantId: TENANT,
  userId: USER_ID,
  appRole: 'agent',
} as TenantAuthContext;

const noopAudit = { describe: jest.fn() };

function orderView(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: ORDER_ID,
    reference: 'ORD-7F3A21',
    status: 'pending_approval',
    total: '349.00',
    currency: 'SAR',
    ...overrides,
  } as OrderView;
}

function makeHarness() {
  const list = jest
    .fn()
    .mockResolvedValue({ orders: [orderView()], nextCursor: null });
  const get = jest.fn().mockResolvedValue({ order: orderView(), items: [] });
  const approve = jest
    .fn()
    .mockResolvedValue(orderView({ status: 'confirmed' }));
  const reject = jest.fn().mockResolvedValue(orderView({ status: 'rejected' }));
  const cancel = jest
    .fn()
    .mockResolvedValue(orderView({ status: 'cancelled' }));
  const retryStorePush = jest.fn().mockResolvedValue(orderView());

  const controller = new OrderController(
    { list, get } as unknown as OrderService,
    {
      approve,
      reject,
      cancel,
      retryStorePush,
    } as unknown as OrderApprovalService,
  );

  return {
    controller,
    list,
    get,
    approve,
    reject,
    cancel,
    retryStorePush,
  };
}

function guardsOn(methodName: keyof OrderController): unknown[] {
  // A metadata reflection target, never invoked, so `this` binding does not
  // apply.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const method = OrderController.prototype[methodName];
  const guards: unknown = Reflect.getMetadata(GUARDS_METADATA, method);
  return Array.isArray(guards) ? (guards as unknown[]) : [];
}

describe('OrderController — routing (F20 P1-1)', () => {
  it('declares /orders/settings on its own, MORE SPECIFIC controller path', () => {
    // This is what makes `/orders/settings` structurally impossible to capture
    // with `/orders/:id` and 400 under ParseUUIDPipe: the literal path is
    // longer and Nest matches it first, whatever order the two controllers are
    // registered in.
    expect(Reflect.getMetadata(PATH_METADATA, OrderController)).toBe('orders');
    expect(Reflect.getMetadata(PATH_METADATA, OrderSettingsController)).toBe(
      'orders/settings',
    );
  });

  it('maps an invalid transition to 409 rather than letting it 500', () => {
    const filter = new InvalidOrderTransitionFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    filter.catch(new InvalidOrderTransitionError('rejected', 'cancelled'), {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, error: 'Conflict' }),
    );
  });
});

describe('OrderController — guards (D7)', () => {
  it.each([['approve'], ['reject'], ['cancel'], ['retryStorePush']] as const)(
    'entitlement-gates %s',
    (method) => {
      expect(guardsOn(method)).toContain(EntitlementGuard);
    },
  );

  it.each([['list'], ['get']] as const)(
    'leaves the read %s open to a lapsed tenant',
    (method) => {
      // A tenant whose subscription lapsed must still be able to SEE the
      // orders they already took; they just cannot work them.
      expect(guardsOn(method)).not.toContain(EntitlementGuard);
    },
  );
});

describe('OrderController — reads', () => {
  it('lists with the caller’s tenant, never one from the query string', async () => {
    const { controller, list } = makeHarness();

    await controller.list(auth, { limit: 20 });

    expect(list).toHaveBeenCalledWith(TENANT, { limit: 20 });
  });

  it("404s an id this tenant cannot see — another tenant's or nonexistent, the same answer", async () => {
    const { controller, get } = makeHarness();
    get.mockResolvedValue(null);

    await expect(controller.get(auth, ORDER_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the order with its price-snapshotted items', async () => {
    const { controller } = makeHarness();

    await expect(controller.get(auth, ORDER_ID)).resolves.toMatchObject({
      order: { reference: 'ORD-7F3A21' },
      items: [],
    });
  });
});

describe('OrderController — transitions', () => {
  it('approves as the CALLING user, never a client-supplied actor', async () => {
    const { controller, approve } = makeHarness();

    await controller.approve(auth, ORDER_ID, noopAudit);

    expect(approve).toHaveBeenCalledWith(TENANT, ORDER_ID, USER_ID);
  });

  it('surfaces a second approve as 409 (D6.2 race #4)', async () => {
    const { controller, approve } = makeHarness();
    approve.mockRejectedValue(new ConflictException('already decided'));

    await expect(
      controller.approve(auth, ORDER_ID, noopAudit),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('404s an approve on an id this tenant cannot see', async () => {
    const { controller, approve } = makeHarness();
    approve.mockRejectedValue(new NotFoundException());

    await expect(
      controller.approve(auth, ORDER_ID, noopAudit),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('passes the rejection reason through', async () => {
    const { controller, reject } = makeHarness();

    await controller.reject(
      auth,
      ORDER_ID,
      { reason: 'Out of stock at the warehouse' },
      noopAudit,
    );

    expect(reject).toHaveBeenCalledWith(
      TENANT,
      ORDER_ID,
      USER_ID,
      'Out of stock at the warehouse',
    );
  });

  it('cancels and retries the store push through the approval service', async () => {
    const { controller, cancel, retryStorePush } = makeHarness();

    await controller.cancel(auth, ORDER_ID, noopAudit);
    await controller.retryStorePush(auth, ORDER_ID, noopAudit);

    expect(cancel).toHaveBeenCalledWith(TENANT, ORDER_ID, USER_ID);
    expect(retryStorePush).toHaveBeenCalledWith(TENANT, ORDER_ID);
  });

  it('audits every transition, so "who approved this order" is answerable', async () => {
    const { controller } = makeHarness();
    const audit = recordingAudit();

    await controller.approve(auth, ORDER_ID, audit);
    await controller.reject(auth, ORDER_ID, { reason: 'fraud' }, audit);
    await controller.cancel(auth, ORDER_ID, audit);
    await controller.retryStorePush(auth, ORDER_ID, audit);

    // QA 2026-10-05: keyed, with the values the console localises from, and
    // the English the log has always shown.
    expect(audit.recorded.map(({ key, params }) => ({ key, params }))).toEqual([
      {
        key: 'order.approved',
        params: { orderRef: 'ORD-7F3A21', total: '349.00', currency: 'SAR' },
      },
      {
        key: 'order.rejected',
        params: { orderRef: 'ORD-7F3A21', reason: 'fraud' },
      },
      { key: 'order.cancelled', params: { orderRef: 'ORD-7F3A21' } },
      { key: 'order.store_push_requeued', params: { orderRef: 'ORD-7F3A21' } },
    ]);
    expect(audit.described[0]).toBe('Approved order ORD-7F3A21 (349.00 SAR)');
  });
});

describe('order request schemas (F20 P1-2: no bare interface on a write)', () => {
  it('rejects a missing rejection reason', () => {
    expect(rejectOrderBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects an empty or over-long rejection reason', () => {
    expect(rejectOrderBodySchema.safeParse({ reason: '   ' }).success).toBe(
      false,
    );
    expect(
      rejectOrderBodySchema.safeParse({ reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(
      rejectOrderBodySchema.safeParse({ reason: 'ok', status: 'confirmed' })
        .success,
    ).toBe(false);
  });

  it('defaults the page size and caps it', () => {
    expect(listOrdersQuerySchema.parse({}).limit).toBe(20);
    expect(listOrdersQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('rejects an unknown status filter and a non-uuid id filter', () => {
    expect(listOrdersQuerySchema.safeParse({ status: 'shipped' }).success).toBe(
      false,
    );
    expect(
      listOrdersQuerySchema.safeParse({ conversationId: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('refuses an empty settings PATCH rather than bumping updated_at for nothing', () => {
    expect(updateOrderSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a settings mode outside the three, and a window outside 1..168', () => {
    expect(updateOrderSettingsSchema.safeParse({ mode: 'yolo' }).success).toBe(
      false,
    );
    expect(
      updateOrderSettingsSchema.safeParse({ approvalWindowHours: 0 }).success,
    ).toBe(false);
    expect(
      updateOrderSettingsSchema.safeParse({ approvalWindowHours: 169 }).success,
    ).toBe(false);
    expect(
      updateOrderSettingsSchema.safeParse({ approvalWindowHours: 24 }).success,
    ).toBe(true);
  });
});

describe('OrderSettingsController — admin only (D7)', () => {
  function makeSettingsHarness() {
    const get = jest.fn().mockResolvedValue({
      tenantId: TENANT,
      mode: 'human_approval',
      codEnabled: true,
      approvalWindowHours: 24,
      autoEnabledAt: null,
      autoEnabledBy: null,
      autoEligibilitySnapshot: null,
    });
    const update = jest
      .fn()
      .mockImplementation(
        (_tenantId: string, _userId: string, body: { mode?: string }) =>
          Promise.resolve({
            tenantId: TENANT,
            mode: body.mode ?? 'human_approval',
            codEnabled: true,
            approvalWindowHours: 24,
            autoEnabledAt: null,
            autoEnabledBy: null,
            autoEligibilitySnapshot: null,
          }),
      );
    const evaluateAutoEligibility = jest
      .fn()
      .mockResolvedValue({ eligible: false, criteria: [], measuredAt: 'now' });
    const syncForModeBestEffort = jest.fn().mockResolvedValue(undefined);

    const controller = new OrderSettingsController(
      {
        get,
        update,
        evaluateAutoEligibility,
      } as unknown as OrderSettingsService,
      { syncForModeBestEffort } as unknown as OrderToolSeederService,
    );
    return {
      controller,
      get,
      update,
      evaluateAutoEligibility,
      syncForModeBestEffort,
    };
  }

  it('is guarded by RolesGuard and restricted to admin', () => {
    // Switching a workspace into unattended ordering is TENANT CONFIGURATION,
    // not working a conversation — an agent-role token gets 403 here.
    expect(
      Reflect.getMetadata(GUARDS_METADATA, OrderSettingsController),
    ).toContain(RolesGuard);
    expect(Reflect.getMetadata(ROLES_KEY, OrderSettingsController)).toEqual([
      'admin',
    ]);
  });

  it('returns the mode alongside computed auto-mode eligibility', async () => {
    const { controller } = makeSettingsHarness();

    await expect(controller.get(auth)).resolves.toMatchObject({
      mode: 'human_approval',
      autoEligibility: { eligible: false },
    });
  });

  it('drives the tool-registry gate from the mode on every change', async () => {
    const { controller, syncForModeBestEffort } = makeSettingsHarness();

    await controller.update(auth, { mode: 'human_approval' }, noopAudit);
    expect(syncForModeBestEffort).toHaveBeenCalledWith(
      TENANT,
      'human_approval',
    );

    await controller.update(auth, { mode: 'disabled' }, noopAudit);
    expect(syncForModeBestEffort).toHaveBeenLastCalledWith(TENANT, 'disabled');
  });

  it('surfaces the 422 when auto mode is requested and D1.5 is not satisfied', async () => {
    const { controller, update } = makeSettingsHarness();
    update.mockRejectedValue(new UnprocessableEntityException());

    await expect(
      controller.update(auth, { mode: 'auto' }, noopAudit),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('audits the mode change', async () => {
    const { controller } = makeSettingsHarness();
    const audit = { describe: jest.fn() };

    await controller.update(auth, { mode: 'human_approval' }, audit);

    expect(audit.describe).toHaveBeenCalledWith(
      'order_settings.updated',
      expect.objectContaining({ mode: 'human_approval' }),
    );
  });
});
