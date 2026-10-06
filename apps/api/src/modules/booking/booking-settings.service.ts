// Clarly 2.0 S2: a tenant's booking configuration. No row = disabled.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  tenantBookingSettings,
  type BookingMode,
  type WeeklyHours,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type {
  BookingSettingsRecord,
  UpdateBookingSettingsBody,
} from './booking.dto';

/** Used only when the first save does not name a zone: the GCC default. */
export const DEFAULT_BOOKING_TIME_ZONE = 'Asia/Riyadh';

export interface BookingSettings {
  mode: BookingMode;
  timeZone: string;
  weeklyHours: WeeklyHours;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
}

/** What a tenant that never saved settings gets: off, and nothing bookable. */
export const DISABLED_BOOKING_SETTINGS: BookingSettings = {
  mode: 'disabled',
  timeZone: DEFAULT_BOOKING_TIME_ZONE,
  weeklyHours: {},
  slotIntervalMinutes: 30,
  minNoticeMinutes: 60,
  maxDaysAhead: 30,
};

@Injectable()
export class BookingSettingsService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async get(tenantId: string): Promise<BookingSettings> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantBookingSettings)
          .where(eq(tenantBookingSettings.tenantId, tenantId))
          .limit(1),
      tenantId,
    );
    if (!row) return { ...DISABLED_BOOKING_SETTINGS };
    return {
      mode: row.mode,
      timeZone: row.timeZone,
      weeklyHours: row.weeklyHours,
      slotIntervalMinutes: row.slotIntervalMinutes,
      minNoticeMinutes: row.minNoticeMinutes,
      maxDaysAhead: row.maxDaysAhead,
    };
  }

  /** Partial upsert. Returns the full settings after the write. */
  async update(
    tenantId: string,
    patch: UpdateBookingSettingsBody,
  ): Promise<BookingSettings> {
    const current = await this.get(tenantId);
    const next: BookingSettings = {
      ...current,
      ...Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ),
    };

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantBookingSettings)
          .values({ tenantId, ...next })
          .onConflictDoUpdate({
            target: tenantBookingSettings.tenantId,
            set: { ...next, updatedAt: new Date() },
          }),
      tenantId,
    );
    return next;
  }
}

export function toSettingsRecord(s: BookingSettings): BookingSettingsRecord {
  return {
    mode: s.mode,
    timeZone: s.timeZone,
    weeklyHours: s.weeklyHours,
    slotIntervalMinutes: s.slotIntervalMinutes,
    minNoticeMinutes: s.minNoticeMinutes,
    maxDaysAhead: s.maxDaysAhead,
  };
}
