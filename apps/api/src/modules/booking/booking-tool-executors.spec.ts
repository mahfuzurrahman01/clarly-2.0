import { ToolScopeViolation } from '@repo/errors';
import type { Clock } from '../core';
import type { BookingCatalogService } from './booking-catalog.service';
import { BookingSlotError } from './booking-errors';
import type { BookingSettingsService } from './booking-settings.service';
import {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
  isGroundedContact,
  phoneDigits,
} from './booking-tool-executors';
import type { BookingService } from './booking.service';

const NOW = new Date('2026-10-07T09:00:00Z'); // 12:00 in Riyadh, a Wednesday
const clock = { now: () => NOW } as Clock;
const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  conversationId: '22222222-2222-4222-8222-222222222222',
  customerId: '33333333-3333-4333-8333-333333333333',
  turnId: 'job-1',
  customerText:
    'Hi, I am Sara, my number is +966 50 123 4567, email sara@example.com',
};
const SERVICE = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: CTX.tenantId,
  name: 'Teeth Cleaning',
  description: null,
  durationMinutes: 45,
  bufferMinutes: 15,
  price: '250.00',
  currency: 'SAR',
  location: 'in_person' as const,
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};
const SETTINGS = {
  mode: 'auto' as const,
  timeZone: 'Asia/Riyadh',
  weeklyHours: { thu: [{ open: '09:00', close: '12:00' }] },
  slotIntervalMinutes: 30,
  minNoticeMinutes: 60,
  maxDaysAhead: 30,
};

function deps(
  overrides: {
    mode?: 'disabled' | 'request' | 'auto';
    create?: jest.Mock;
  } = {},
) {
  const settings = {
    get: jest
      .fn()
      .mockResolvedValue({ ...SETTINGS, mode: overrides.mode ?? 'auto' }),
  } as unknown as BookingSettingsService;
  const catalog = {
    list: jest.fn().mockResolvedValue([SERVICE]),
  } as unknown as BookingCatalogService;
  const create =
    overrides.create ??
    jest.fn().mockResolvedValue({
      duplicate: false,
      booking: {
        reference: 'BK-7Q2M9X',
        status: 'confirmed',
        serviceName: 'Teeth Cleaning',
        startsAt: new Date('2026-10-08T13:30:00Z'),
        endsAt: new Date('2026-10-08T14:15:00Z'),
        timeZone: 'Asia/Riyadh',
        location: 'in_person',
        meetingUrl: null,
      },
    });
  const bookingService = {
    create,
    inBookingRange: jest.fn().mockReturnValue(true),
    dayAvailability: jest.fn().mockResolvedValue({
      slots: [{ localTime: '10:00' }, { localTime: '10:30' }],
      calendarChecked: true,
    }),
    upcomingAvailability: jest.fn().mockResolvedValue({
      calendarChecked: true,
      days: [
        {
          date: { year: 2026, month: 10, day: 8 },
          slots: [{ localTime: '09:00' }],
        },
      ],
    }),
  } as unknown as BookingService;
  return { settings, catalog, bookingService, create };
}

describe('phoneDigits / isGroundedContact', () => {
  it('folds Arabic-Indic digits', () => {
    expect(phoneDigits('٠٥٠١٢٣٤٥٦٧')).toBe('0501234567');
  });
  it('accepts a phone the customer wrote, in another format', () => {
    expect(isGroundedContact('0501234567', 'phone', CTX.customerText)).toBe(
      true,
    );
  });
  it('refuses a phone the customer never wrote', () => {
    expect(isGroundedContact('0559876543', 'phone', CTX.customerText)).toBe(
      false,
    );
  });
  it('checks emails case-insensitively', () => {
    expect(
      isGroundedContact('Sara@Example.com', 'email', CTX.customerText),
    ).toBe(true);
    expect(
      isGroundedContact('other@example.com', 'email', CTX.customerText),
    ).toBe(false);
  });
  it('skips the check when no customer text was supplied', () => {
    expect(isGroundedContact('0559876543', 'phone', undefined)).toBe(true);
  });
});

describe('CheckAvailabilityExecutor', () => {
  it('without a date, returns today and the next days with times', async () => {
    const d = deps();
    const exec = new CheckAvailabilityExecutor(
      d.settings,
      d.catalog,
      d.bookingService,
      clock,
    );
    const result = await exec.execute(CTX, { service: 'cleaning' });
    expect(result).toMatchObject({
      status: 'ok',
      today: '2026-10-07',
      todayWeekday: 'wed',
      days: [{ date: '2026-10-08', weekday: 'thu', times: ['09:00'] }],
      service: { name: 'Teeth Cleaning', price: '250.00', currency: 'SAR' },
    });
  });

  it('with a date, returns that day’s times', async () => {
    const d = deps();
    const exec = new CheckAvailabilityExecutor(
      d.settings,
      d.catalog,
      d.bookingService,
      clock,
    );
    await expect(
      exec.execute(CTX, { service: 'cleaning', date: '2026-10-08' }),
    ).resolves.toMatchObject({
      status: 'ok',
      weekday: 'thu',
      times: ['10:00', '10:30'],
    });
  });

  it('lists the real services when the name matches none', async () => {
    const d = deps();
    const exec = new CheckAvailabilityExecutor(
      d.settings,
      d.catalog,
      d.bookingService,
      clock,
    );
    await expect(exec.execute(CTX, { service: 'massage' })).resolves.toEqual({
      status: 'no_such_service',
      services: ['Teeth Cleaning'],
      customerMessage: 'ask_which_service',
    });
  });

  // Execution gate: a stale enabled tool row cannot reach the calendar.
  it('refuses when bookings are disabled', async () => {
    const d = deps({ mode: 'disabled' });
    const exec = new CheckAvailabilityExecutor(
      d.settings,
      d.catalog,
      d.bookingService,
      clock,
    );
    await expect(
      exec.execute(CTX, { service: 'cleaning' }),
    ).resolves.toMatchObject({
      status: 'bookings_unavailable',
    });
  });
});

describe('BookAppointmentExecutor', () => {
  const ARGS = {
    service: 'Teeth Cleaning',
    date: '2026-10-08',
    time: '16:30',
    customerName: 'Sara',
  };

  it('refuses a non-conversational caller', async () => {
    const d = deps();
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    await expect(
      exec.execute({ ...CTX, customerId: null }, ARGS),
    ).rejects.toBeInstanceOf(ToolScopeViolation);
  });

  it('asks for the name instead of booking a placeholder', async () => {
    const d = deps();
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    await expect(
      exec.execute(CTX, { ...ARGS, customerName: 'Customer' }),
    ).resolves.toMatchObject({
      status: 'refused',
      customerMessage: 'ask_customer_for_name',
    });
    expect(d.create).not.toHaveBeenCalled();
  });

  it('refuses a phone number the customer did not write', async () => {
    const d = deps();
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    await expect(
      exec.execute(CTX, { ...ARGS, customerPhone: '0559876543' }),
    ).resolves.toMatchObject({
      reason: 'unverified_contact',
    });
  });

  it('books and reports local date, weekday and time', async () => {
    const d = deps();
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    const result = await exec.execute(CTX, {
      ...ARGS,
      customerPhone: '+966501234567',
    });
    expect(result).toEqual({
      status: 'confirmed',
      bookingReference: 'BK-7Q2M9X',
      service: 'Teeth Cleaning',
      date: '2026-10-08',
      weekday: 'thu',
      time: '16:30',
      durationMinutes: 45,
      location: 'in_person',
      meetingUrl: null,
      duplicate: false,
      customerMessage: 'appointment_confirmed',
    });
    expect(d.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'agent',
        startMinutes: 16 * 60 + 30,
        customerId: CTX.customerId,
        customerPhone: '+966501234567',
      }),
    );
  });

  // Same turn, same request → same key, so a BullMQ retry re-reads, never re-books.
  it('derives a stable idempotency key from the turn', async () => {
    const d = deps();
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    await exec.execute(CTX, ARGS);
    await exec.execute(CTX, ARGS);
    const calls = d.create.mock.calls as Array<[{ idempotencyKey: string }]>;
    const keys = calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it('turns a taken slot into alternatives for the same day', async () => {
    const d = deps({
      create: jest.fn().mockRejectedValue(new BookingSlotError('taken')),
    });
    const exec = new BookAppointmentExecutor(
      d.catalog,
      d.settings,
      d.bookingService,
      clock,
    );
    await expect(exec.execute(CTX, ARGS)).resolves.toMatchObject({
      status: 'refused',
      reason: 'slot_unavailable',
      alternatives: ['10:00', '10:30'],
      customerMessage: 'time_no_longer_available',
    });
  });
});
