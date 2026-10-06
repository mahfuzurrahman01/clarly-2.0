// Clarly 2.0 S2: the services a tenant offers for booking.
import { ConflictException, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { bookingServices } from '../persistence/drizzle/schema';
import { isUniqueViolation } from '../persistence/postgres-error';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  BookingServiceRecord,
  CreateBookingServiceBody,
  UpdateBookingServiceBody,
} from './booking.dto';

type ServiceRow = typeof bookingServices.$inferSelect;

export function toServiceRecord(row: ServiceRow): BookingServiceRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    durationMinutes: row.durationMinutes,
    bufferMinutes: row.bufferMinutes,
    price: row.price,
    currency: row.currency,
    location: row.location,
    active: row.active,
  };
}

/** Lower-cased, whitespace-collapsed, Arabic tatweel removed — how a customer's wording is compared to a service name. */
export function normaliseServiceName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/ـ/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Picks the service a free-text name refers to: an exact (normalised) match,
 * else the only service whose name contains the words or is contained in
 * them. Two partial matches is ambiguous — null — so the agent asks rather
 * than booking the wrong thing.
 */
export function matchService<T extends { id: string; name: string }>(
  services: readonly T[],
  wanted: string,
): T | null {
  const key = normaliseServiceName(wanted);
  if (!key) return null;
  const byId = services.find((s) => s.id === wanted.trim());
  if (byId) return byId;
  const exact = services.filter((s) => normaliseServiceName(s.name) === key);
  if (exact.length === 1) return exact[0];
  const partial = services.filter((s) => {
    const name = normaliseServiceName(s.name);
    return name.includes(key) || key.includes(name);
  });
  return partial.length === 1 ? partial[0] : null;
}

@Injectable()
export class BookingCatalogService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async list(
    tenantId: string,
    options: { activeOnly?: boolean } = {},
  ): Promise<ServiceRow[]> {
    return this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(bookingServices)
          .where(
            options.activeOnly
              ? and(
                  eq(bookingServices.tenantId, tenantId),
                  eq(bookingServices.active, true),
                )
              : eq(bookingServices.tenantId, tenantId),
          )
          .orderBy(asc(bookingServices.name)),
      tenantId,
    );
  }

  async get(tenantId: string, id: string): Promise<ServiceRow | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(bookingServices)
          .where(
            and(
              eq(bookingServices.tenantId, tenantId),
              eq(bookingServices.id, id),
            ),
          )
          .limit(1),
      tenantId,
    );
    return row ?? null;
  }

  async create(
    tenantId: string,
    body: CreateBookingServiceBody,
  ): Promise<ServiceRow> {
    try {
      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .insert(bookingServices)
            .values({
              tenantId,
              name: body.name,
              description: body.description ?? null,
              durationMinutes: body.durationMinutes,
              bufferMinutes: body.bufferMinutes ?? 0,
              price: body.price ?? null,
              currency: body.currency ?? null,
              location: body.location ?? 'in_person',
              active: body.active ?? true,
            })
            .returning(),
        tenantId,
      );
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A service with this name already exists');
      }
      throw error;
    }
  }

  async update(
    tenantId: string,
    id: string,
    body: UpdateBookingServiceBody,
  ): Promise<ServiceRow | null> {
    const set = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    try {
      const [row] = await this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(bookingServices)
            .set({ ...set, updatedAt: sql`now()` })
            .where(
              and(
                eq(bookingServices.tenantId, tenantId),
                eq(bookingServices.id, id),
              ),
            )
            .returning(),
        tenantId,
      );
      return row ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A service with this name already exists');
      }
      throw error;
    }
  }
}
