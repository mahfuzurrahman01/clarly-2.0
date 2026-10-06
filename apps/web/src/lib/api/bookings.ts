import { apiFetch, browserApiFetch } from "./client";

/**
 * Clarly 2.0 S2 — console client for `/bookings/*`. Contract of record: the
 * "v2 S2 — Bookings" entry in docs/HANDOFF.md.
 *
 * Wire details:
 *  - `date` + `time` going IN are LOCAL to the workspace time zone
 *    (`YYYY-MM-DD`, `HH:MM`); `startsAt`/`endsAt` coming OUT are ISO instants.
 *    Render them with `timeZone` from the booking, never the browser's zone.
 *  - `price` is a decimal string ("250.00") or null (price on request).
 *  - The list is ascending by start time and cursor-paged.
 */

export const BOOKING_MODES = ["disabled", "request", "auto"] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const BOOKING_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type BookingWeekday = (typeof BOOKING_WEEKDAYS)[number];

export type OpeningWindow = { open: string; close: string };
export type WeeklyHours = Partial<Record<BookingWeekday, OpeningWindow[]>>;

export type BookingSettings = {
  mode: BookingMode;
  timeZone: string;
  weeklyHours: WeeklyHours;
  slotIntervalMinutes: number;
  minNoticeMinutes: number;
  maxDaysAhead: number;
};

export const BOOKING_LOCATIONS = ["in_person", "online", "phone"] as const;
export type BookingLocation = (typeof BOOKING_LOCATIONS)[number];

export type BookingServiceItem = {
  id: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  bufferMinutes: number;
  price: string | null;
  currency: string | null;
  location: BookingLocation;
  active: boolean;
};

export const BOOKING_STATUSES = ["requested", "confirmed", "cancelled", "completed", "no_show"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export type CalendarSyncStatus = "not_applicable" | "pending" | "synced" | "failed";

export type Booking = {
  id: string;
  reference: string;
  status: BookingStatus;
  serviceId: string;
  serviceName: string;
  location: BookingLocation;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  customerId: string | null;
  conversationId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  notes: string | null;
  meetingUrl: string | null;
  calendarSyncStatus: CalendarSyncStatus;
  calendarSyncError: string | null;
  source: "agent" | "console";
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
};

export type BookingPage = { items: Booking[]; nextCursor: string | null };

export type Availability = {
  date: string;
  timeZone: string;
  slots: { time: string; startsAt: string; endsAt: string }[];
  calendarChecked: boolean;
};

export type CalendarStatus = {
  configured: boolean;
  connection: {
    provider: "google";
    accountEmail: string | null;
    status: "active" | "needs_reconnect";
    lastError: string | null;
    connectedAt: string;
  } | null;
};

export type ListBookingsParams = {
  status?: BookingStatus;
  order?: "asc" | "desc";
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
};

export const BOOKINGS_PAGE_SIZE = 50;

function query(params: ListBookingsParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

// --- server-side reads (Server Components pass the session token) ---------

export function getBookingSettings(token: string) {
  return apiFetch<BookingSettings>("/bookings/settings", { token });
}
export function listBookingServices(token: string) {
  return apiFetch<BookingServiceItem[]>("/bookings/services", { token });
}
export function listBookings(params: ListBookingsParams, token?: string) {
  const path = `/bookings${query(params)}`;
  return token ? apiFetch<BookingPage>(path, { token }) : browserApiFetch<BookingPage>(path);
}
export function getCalendarStatus(token: string) {
  return apiFetch<CalendarStatus>("/bookings/calendar", { token });
}

// --- browser-side writes ---------------------------------------------------

export function updateBookingSettings(patch: Partial<BookingSettings>) {
  return browserApiFetch<BookingSettings>("/bookings/settings", { method: "PATCH", json: patch });
}

export type BookingServiceInput = {
  name: string;
  description?: string | null;
  durationMinutes: number;
  bufferMinutes?: number;
  price?: number | null;
  currency?: string | null;
  location?: BookingLocation;
  active?: boolean;
};

export function createBookingService(input: BookingServiceInput) {
  return browserApiFetch<BookingServiceItem>("/bookings/services", { method: "POST", json: input });
}
export function updateBookingService(id: string, patch: Partial<BookingServiceInput>) {
  return browserApiFetch<BookingServiceItem>(`/bookings/services/${id}`, { method: "PATCH", json: patch });
}

export function getAvailability(serviceId: string, date: string) {
  return browserApiFetch<Availability>(
    `/bookings/availability?serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}`,
  );
}

export type NewBookingInput = {
  serviceId: string;
  date: string;
  time: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  notes?: string | null;
  status?: "requested" | "confirmed";
};

export function createBooking(input: NewBookingInput) {
  return browserApiFetch<Booking>("/bookings", { method: "POST", json: input });
}
export function confirmBooking(id: string) {
  return browserApiFetch<Booking>(`/bookings/${id}/confirm`, { method: "POST" });
}
export function cancelBooking(id: string, reason?: string) {
  return browserApiFetch<Booking>(`/bookings/${id}/cancel`, {
    method: "POST",
    json: reason ? { reason } : {},
  });
}
export function completeBooking(id: string) {
  return browserApiFetch<Booking>(`/bookings/${id}/complete`, { method: "POST" });
}
export function markBookingNoShow(id: string) {
  return browserApiFetch<Booking>(`/bookings/${id}/no-show`, { method: "POST" });
}

export function startCalendarConnect() {
  return browserApiFetch<{ url: string }>("/bookings/calendar/connect", { method: "POST" });
}
export function disconnectCalendar() {
  return browserApiFetch<void>("/bookings/calendar", { method: "DELETE" });
}
