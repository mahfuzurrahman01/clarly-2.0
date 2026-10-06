// Clarly 2.0 S2: bookings end to end against real Postgres (FORCE RLS) and
// Redis, over real HTTP with real signed JWTs, plus the agent executors.
//
// Proves:
//   - settings default to disabled; only an admin can change them; turning
//     bookings on enables the two agent tools for THAT tenant only
//   - availability honours opening hours, duration and buffer
//   - the agent books, a retried turn re-reads instead of re-booking, and two
//     customers racing for one time cannot both get it (advisory lock)
//   - console bookings cannot overlap; cancelling frees the slot
//   - `request` mode records a request, notifies the team, and a person
//     confirms it
//   - another tenant cannot read a booking (RLS) and the calendar callback
//     rejects a forged state
//
// Requires real Postgres + Redis. Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuditModule } from '../../src/modules/audit/audit.module';
import { AuthModule } from '../../src/modules/auth/auth.module';
import { BookingModule } from '../../src/modules/booking/booking.module';
import {
  BookAppointmentExecutor,
  CheckAvailabilityExecutor,
} from '../../src/modules/booking/booking-tool-executors';
import {
  addDays,
  formatLocalDate,
  localToday,
  weekdayIndex,
} from '../../src/modules/booking/booking-time';
import { AppConfigService } from '../../src/modules/core';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  customers,
  notifications,
  plans,
  tenants,
  tenantSubscriptions,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { TenantToolRegistryService } from '../../src/modules/tool-registry/tenant-tool-registry.service';

function sign(
  secret: string,
  tenantId: string,
  role: 'admin' | 'agent',
  sub = randomUUID(),
): string {
  return jwt.sign(
    {
      sub,
      role: 'authenticated',
      app_metadata: { tenant_id: tenantId, app_role: role },
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );
}

interface BookingBody {
  id: string;
  reference: string;
  status: string;
}

describe('bookings (v2 S2)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let secret: string;
  const server = (): Server => app.getHttpServer() as Server;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const planId = randomUUID();
  const customerA1 = randomUUID();
  const customerA2 = randomUUID();
  let adminA: string;
  let agentA: string;
  let adminB: string;
  let serviceId: string;

  // A Thursday at least two days ahead, in Riyadh: clear of the 60-minute notice.
  let thursday: string;

  const ctxFor = (customerId: string, turnId: string) => ({
    tenantId: tenantA,
    conversationId: null,
    customerId,
    turnId,
    customerText: 'Hello, I am Sara Ahmed',
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        AuthModule,
        AuditModule,
        BookingModule,
      ],
    }).compile();
    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    secret = moduleRef.get(AppConfigService).supabaseJwtSecret;
    await persistence.runMigrations();

    let day = addDays(localToday(Date.now(), 'Asia/Riyadh'), 2);
    while (weekdayIndex(day) !== 4) day = addDays(day, 1);
    thursday = formatLocalDate(day);

    await persistence.runAdminQuery(async (db) => {
      await db.insert(tenants).values([
        {
          id: tenantA,
          name: 'Lumen Clinic (bookings spec)',
          vertical: 'services',
        },
        { id: tenantB, name: 'Other Clinic (bookings spec)' },
      ]);
      await db.insert(plans).values({
        id: planId,
        name: `Bookings spec ${planId.slice(0, 6)}`,
        stripePriceId: `price_${planId.slice(0, 8)}`,
        monthlyMessageLimit: 1000,
        monthlySpendCapUsd: 50,
      });
    });
    for (const t of [tenantA, tenantB]) {
      await tenantContext.withTenantTx(
        (tx) =>
          tx.insert(tenantSubscriptions).values({
            tenantId: t,
            planId,
            status: 'active',
            comped: true,
            compedBy: 'bookings-spec',
            compedReason: 'integration test',
          }),
        t,
      );
    }
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(customers).values([
          {
            id: customerA1,
            tenantId: tenantA,
            channel: 'whatsapp',
            phone: '+966500000001',
            name: 'Sara',
          },
          {
            id: customerA2,
            tenantId: tenantA,
            channel: 'whatsapp',
            phone: '+966500000002',
            name: 'Huda',
          },
        ]),
      tenantA,
    );

    adminA = sign(secret, tenantA, 'admin');
    agentA = sign(secret, tenantA, 'agent');
    adminB = sign(secret, tenantB, 'admin');

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await persistence.runAdminQuery(async (db) => {
      await db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
      await db.delete(plans).where(eq(plans.id, planId));
    });
    await app.close();
  });

  it('defaults to disabled', async () => {
    const res = await request(server())
      .get('/bookings/settings')
      .set('Authorization', `Bearer ${agentA}`)
      .expect(200);
    expect(res.body).toMatchObject({ mode: 'disabled', weeklyHours: {} });
  });

  it('lets only an admin turn bookings on, and enables the tools for that tenant only', async () => {
    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${agentA}`)
      .send({ mode: 'auto' })
      .expect(403);

    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${adminA}`)
      .send({
        mode: 'auto',
        timeZone: 'Asia/Riyadh',
        weeklyHours: { thu: [{ open: '09:00', close: '12:00' }] },
        slotIntervalMinutes: 30,
        minNoticeMinutes: 60,
      })
      .expect(200);

    const registry = moduleRef.get(TenantToolRegistryService);
    expect(
      await registry.isToolEnabledForTenant(tenantA, 'book_appointment'),
    ).toBe(true);
    expect(
      await registry.isToolEnabledForTenant(tenantA, 'check_availability'),
    ).toBe(true);
    expect(
      await registry.isToolEnabledForTenant(tenantB, 'book_appointment'),
    ).toBe(false);
  });

  it('rejects an unknown time zone and overlapping windows', async () => {
    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ timeZone: 'Mars/Olympus' })
      .expect(400);
    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${adminA}`)
      .send({
        weeklyHours: {
          mon: [
            { open: '09:00', close: '12:00' },
            { open: '11:00', close: '13:00' },
          ],
        },
      })
      .expect(400);
  });

  it('adds a service and refuses a duplicate name', async () => {
    const res = await request(server())
      .post('/bookings/services')
      .set('Authorization', `Bearer ${adminA}`)
      .send({
        name: 'Teeth Cleaning',
        durationMinutes: 45,
        bufferMinutes: 15,
        price: 250,
        currency: 'sar',
      })
      .expect(201);
    serviceId = (res.body as { id: string }).id;
    expect(res.body).toMatchObject({
      price: '250.00',
      currency: 'SAR',
      location: 'in_person',
    });

    await request(server())
      .post('/bookings/services')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ name: 'teeth cleaning', durationMinutes: 30 })
      .expect(409);
  });

  it('offers grid times that fit the window', async () => {
    const res = await request(server())
      .get('/bookings/availability')
      .query({ serviceId, date: thursday })
      .set('Authorization', `Bearer ${agentA}`)
      .expect(200);
    const times = (res.body as { slots: { time: string }[] }).slots.map(
      (s) => s.time,
    );
    expect(times).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('lets the agent see availability without knowing the date', async () => {
    const exec = moduleRef.get(CheckAvailabilityExecutor);
    const result = await exec.execute(ctxFor(customerA1, 'turn-x'), {
      service: 'cleaning',
    });
    expect(result.status).toBe('ok');
    expect(typeof (result as { todayWeekday: string }).todayWeekday).toBe(
      'string',
    );
    expect(
      (result as { days: { date: string }[] }).days.map((d) => d.date),
    ).toContain(thursday);
  });

  let agentBookingRef: string;

  it('books through the agent tool, and a retried turn re-reads the same booking', async () => {
    const exec = moduleRef.get(BookAppointmentExecutor);
    const args = {
      service: 'Teeth Cleaning',
      date: thursday,
      time: '09:00',
      customerName: 'Sara Ahmed',
    };
    const first = await exec.execute(ctxFor(customerA1, 'turn-1'), args);
    expect(first).toMatchObject({
      status: 'confirmed',
      time: '09:00',
      weekday: 'thu',
      duplicate: false,
    });
    agentBookingRef = (first as { bookingReference: string }).bookingReference;

    const retried = await exec.execute(ctxFor(customerA1, 'turn-1'), args);
    expect(retried).toMatchObject({
      bookingReference: agentBookingRef,
      duplicate: true,
    });
  });

  it('never gives one time to two customers racing for it', async () => {
    const exec = moduleRef.get(BookAppointmentExecutor);
    const args = {
      service: 'Teeth Cleaning',
      date: thursday,
      time: '10:30',
      customerName: 'Sara Ahmed',
    };
    const results = await Promise.all([
      exec.execute(ctxFor(customerA1, 'race-1'), args),
      exec.execute(ctxFor(customerA2, 'race-2'), args),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['confirmed', 'refused']);
    const refused = results.find((r) => r.status === 'refused');
    expect(refused).toMatchObject({
      customerMessage: 'time_no_longer_available',
    });
  });

  it('takes the booked time (and its buffer) out of availability', async () => {
    const res = await request(server())
      .get('/bookings/availability')
      .query({ serviceId, date: thursday })
      .set('Authorization', `Bearer ${agentA}`)
      .expect(200);
    const times = (res.body as { slots: { time: string }[] }).slots.map(
      (s) => s.time,
    );
    // Each booking holds 45 min + 15 min buffer: 09:00 holds 09:00-10:00 and
    // 10:30 holds 10:30-11:30. Every candidate also needs 60 min clear:
    // 09:30 hits the first, 10:00 and 11:00 hit the second. Nothing is left.
    expect(times).toEqual([]);
  });

  it('refuses a console booking on top of an existing one (409 taken)', async () => {
    const res = await request(server())
      .post('/bookings')
      .set('Authorization', `Bearer ${agentA}`)
      .send({
        serviceId,
        date: thursday,
        time: '09:15',
        customerName: 'Walk-in',
      })
      .expect(409);
    expect(res.body).toMatchObject({ reason: 'taken' });
  });

  it('allows a console booking outside opening hours', async () => {
    const res = await request(server())
      .post('/bookings')
      .set('Authorization', `Bearer ${agentA}`)
      .send({
        serviceId,
        date: thursday,
        time: '13:10',
        customerName: 'Walk-in',
      })
      .expect(201);
    expect(res.body).toMatchObject({ status: 'confirmed', source: 'console' });
  });

  it('hides a booking from another tenant (RLS)', async () => {
    const list = await request(server())
      .get('/bookings')
      .set('Authorization', `Bearer ${adminA}`)
      .expect(200);
    const items = (list.body as { items: BookingBody[] }).items;
    expect(items.map((b) => b.reference)).toContain(agentBookingRef);
    const id = items.find((b) => b.reference === agentBookingRef)?.id;

    await request(server())
      .get(`/bookings/${id}`)
      .set('Authorization', `Bearer ${adminB}`)
      .expect(404);
    const listB = await request(server())
      .get('/bookings')
      .set('Authorization', `Bearer ${adminB}`)
      .expect(200);
    expect((listB.body as { items: unknown[] }).items).toHaveLength(0);
  });

  it('cancels, frees the slot, and refuses to cancel twice', async () => {
    const list = await request(server())
      .get('/bookings')
      .set('Authorization', `Bearer ${adminA}`);
    const id = (list.body as { items: BookingBody[] }).items.find(
      (b) => b.reference === agentBookingRef,
    )?.id;

    const res = await request(server())
      .post(`/bookings/${id}/cancel`)
      .set('Authorization', `Bearer ${agentA}`)
      .send({ reason: 'Customer asked' })
      .expect(200);
    expect(res.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer asked',
    });

    await request(server())
      .post(`/bookings/${id}/cancel`)
      .set('Authorization', `Bearer ${agentA}`)
      .send({})
      .expect(409);

    const avail = await request(server())
      .get('/bookings/availability')
      .query({ serviceId, date: thursday })
      .set('Authorization', `Bearer ${agentA}`);
    expect(
      (avail.body as { slots: { time: string }[] }).slots.map((s) => s.time),
    ).toContain('09:00');
  });

  it('in request mode records a request, notifies the team, and a person confirms it', async () => {
    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ mode: 'request' })
      .expect(200);

    const exec = moduleRef.get(BookAppointmentExecutor);
    const result = await exec.execute(ctxFor(customerA2, 'turn-req'), {
      service: 'Teeth Cleaning',
      date: thursday,
      time: '09:00',
      customerName: 'Sara Ahmed',
    });
    expect(result).toMatchObject({
      status: 'requested',
      customerMessage: 'appointment_requested_awaiting_confirmation',
    });

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ kind: notifications.kind })
          .from(notifications)
          .where(
            and(
              eq(notifications.tenantId, tenantA),
              eq(notifications.kind, 'booking_requested'),
            ),
          ),
      tenantA,
    );
    expect(rows).toHaveLength(1);

    const list = await request(server())
      .get('/bookings')
      .query({ status: 'requested' })
      .set('Authorization', `Bearer ${adminA}`);
    const id = (list.body as { items: BookingBody[] }).items[0].id;
    const confirmed = await request(server())
      .post(`/bookings/${id}/confirm`)
      .set('Authorization', `Bearer ${agentA}`)
      .expect(200);
    expect(confirmed.body).toMatchObject({
      status: 'confirmed',
      calendarSyncStatus: 'not_applicable',
    });
  });

  it('reports the calendar as not configured and refuses to start a connect', async () => {
    const status = await request(server())
      .get('/bookings/calendar')
      .set('Authorization', `Bearer ${adminA}`)
      .expect(200);
    expect(status.body).toEqual({ configured: false, connection: null });
    await request(server())
      .post('/bookings/calendar/connect')
      .set('Authorization', `Bearer ${adminA}`)
      .expect(503);
  });

  it('bounces a forged OAuth callback back to the console without touching any tenant', async () => {
    const res = await request(server())
      .get('/bookings/calendar/callback')
      .query({ code: 'x', state: 'forged' })
      .expect(302);
    expect(res.headers.location).toContain(
      '/settings/bookings?calendar=invalid_state',
    );
  });

  it('turning bookings off disables the tools again', async () => {
    await request(server())
      .patch('/bookings/settings')
      .set('Authorization', `Bearer ${adminA}`)
      .send({ mode: 'disabled' })
      .expect(200);
    const registry = moduleRef.get(TenantToolRegistryService);
    expect(
      await registry.isToolEnabledForTenant(tenantA, 'book_appointment'),
    ).toBe(false);
  });
});
