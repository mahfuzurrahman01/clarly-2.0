// F26 (D5, D10): the per-tenant opt-in.
//
// The default is the whole point. Every message this feature sends is a
// billed, business-initiated WhatsApp template, and "we turned it on for you"
// is not a recoverable mistake — Meta has already charged the merchant and
// their customer has already been messaged.
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  DeliveryNotificationSettingsService,
  NOTIFIABLE_STATUSES,
} from './delivery-notification-settings.service';
import { SHIPMENT_STATUSES } from '../persistence/drizzle/schema';

function chain(rows: unknown[]): any {
  const self: any = {
    where: () => self,
    limit: () => self,
    returning: () => self,
    onConflictDoUpdate: () => self,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve),
  };
  return self;
}

function makeService(existing: Record<string, unknown> | null) {
  const stored = existing ? [existing] : [];
  const tenantContext = {
    withTenantTx: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({ from: () => chain(stored) }),
        insert: () => ({
          values: (values: Record<string, unknown>) =>
            chain([{ ...values, updatedAt: new Date() }]),
        }),
      }),
    ),
  } as unknown as TenantContextService;

  return new DeliveryNotificationSettingsService(tenantContext);
}

describe('DeliveryNotificationSettingsService', () => {
  // A tenant with no row is not an error — it is a tenant who has not opted
  // in, which is the default state and the one that must never send.
  it('answers an absent row with the disabled defaults, not null', async () => {
    const service = makeService(null);

    await expect(service.get('tenant-a')).resolves.toEqual({
      tenantId: 'tenant-a',
      enabled: false,
      statusTemplates: {},
      updatedAt: null,
    });
  });

  it('returns what the tenant configured', async () => {
    const service = makeService({
      tenantId: 'tenant-a',
      enabled: true,
      statusTemplates: { delivered: 'template-1' },
      updatedAt: new Date('2026-09-20T00:00:00Z'),
    });

    const settings = await service.get('tenant-a');

    expect(settings.enabled).toBe(true);
    expect(settings.statusTemplates).toEqual({ delivered: 'template-1' });
  });

  it('upserts rather than requiring the row to exist first', async () => {
    const service = makeService(null);

    const saved = await service.upsert('tenant-a', {
      enabled: true,
      statusTemplates: { out_for_delivery: 'template-2' },
    });

    expect(saved.enabled).toBe(true);
    expect(saved.statusTemplates).toEqual({
      out_for_delivery: 'template-2',
    });
  });

  it('offers only statuses that are actually worth a billed message', () => {
    for (const status of NOTIFIABLE_STATUSES) {
      expect(SHIPMENT_STATUSES).toContain(status);
    }
    // Nobody wants a WhatsApp message saying "your label has been created",
    // and `unknown`/`exception` are not statements we can make to a customer.
    expect(NOTIFIABLE_STATUSES).not.toContain('label_created');
    expect(NOTIFIABLE_STATUSES).not.toContain('unknown');
    expect(NOTIFIABLE_STATUSES).not.toContain('exception');
  });
});
