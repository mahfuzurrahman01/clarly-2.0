// Clarly 2.0 S2: the calendar a tenant's bookings are written to, behind a
// port so a second provider (Microsoft 365) is an adapter, not a rewrite.
import type { Interval } from '../booking-slots';

/** What is stored, encrypted, per connection. Never returned by any DTO. */
export interface CalendarCredentials {
  refreshToken: string;
}

export interface CalendarEventInput {
  summary: string;
  description: string;
  startMs: number;
  endMs: number;
  timeZone: string;
  /** Ask the provider for a video meeting link (online services). */
  withVideoMeeting: boolean;
  attendeeEmail: string | null;
  /** Stable per booking, so a retried create cannot produce two events. */
  requestId: string;
}

export interface CreatedCalendarEvent {
  eventId: string;
  meetingUrl: string | null;
}

/** The tenant's grant is gone (revoked, expired): the connection must be marked `needs_reconnect`. */
export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

/** The provider failed for a reason that may pass (network, 5xx, rate limit). */
export class CalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarUnavailableError';
  }
}

export abstract class CalendarProvider {
  abstract readonly name: 'google';
  /** Whether the platform has OAuth client credentials for this provider. */
  abstract isConfigured(): boolean;
  abstract buildAuthUrl(state: string): string;
  abstract exchangeCode(
    code: string,
  ): Promise<{ credentials: CalendarCredentials; accountEmail: string | null }>;
  abstract busyIntervals(
    credentials: CalendarCredentials,
    calendarId: string,
    fromMs: number,
    toMs: number,
  ): Promise<Interval[]>;
  abstract createEvent(
    credentials: CalendarCredentials,
    calendarId: string,
    input: CalendarEventInput,
  ): Promise<CreatedCalendarEvent>;
  abstract deleteEvent(
    credentials: CalendarCredentials,
    calendarId: string,
    eventId: string,
  ): Promise<void>;
  abstract revoke(credentials: CalendarCredentials): Promise<void>;
}
