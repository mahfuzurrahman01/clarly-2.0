// Clarly 2.0 S2: Google Calendar over plain HTTPS (no googleapis SDK — five
// endpoints do not justify a 100 MB dependency).
//
// Carried over from Autologic's gcal.js, where each line was paid for:
//   - `transparency: opaque` + `status: confirmed`, or the slot does not come
//     back as busy and the next customer is offered the same time;
//   - Meet links are created asynchronously: re-read the event a few times
//     before giving up on the link;
//   - `sendUpdates=all` on create AND delete, or a cancelled customer keeps a
//     live invitation;
//   - `invalid_grant` on refresh means the grant is dead (revoked, or the
//     7-day refresh token of an unverified app): surface it so the console
//     asks for a reconnect instead of failing every booking silently.
// New here: per-instance access-token cache, per-call timeout, and a
// deterministic `requestId` so a retried create cannot make two Meet rooms.
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfigService } from '../../core';
import type { Interval } from '../booking-slots';
import {
  CalendarAuthError,
  CalendarProvider,
  CalendarUnavailableError,
  type CalendarCredentials,
  type CalendarEventInput,
  type CreatedCalendarEvent,
} from './calendar-provider.port';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

const REQUEST_TIMEOUT_MS = 8_000;
const MEET_LINK_RETRIES = 3;
/** Refresh a cached token this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000;

export type FetchLike = typeof fetch;
export type SleepLike = (ms: number) => Promise<void>;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

interface GoogleEvent {
  id?: string;
  hangoutLink?: string;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  error?: { message?: string };
}

export function pickMeetLink(event: GoogleEvent | null): string | null {
  if (!event) return null;
  return (
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
      ?.uri ||
    null
  );
}

function tokenCacheKey(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex');
}

@Injectable()
export class GoogleCalendarProvider extends CalendarProvider {
  readonly name = 'google' as const;
  private readonly tokens = new Map<string, CachedToken>();
  private fetchImpl: FetchLike = (
    input: Parameters<FetchLike>[0],
    init?: RequestInit,
  ) => fetch(input, init);
  private sleep: SleepLike = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  private now: () => number = () => Date.now();

  constructor(private readonly config: AppConfigService) {
    super();
  }

  /** Test seam: swap the network, the clock and the sleep. */
  useTransport(
    fetchImpl: FetchLike,
    sleep: SleepLike = async () => {},
    now: () => number = () => Date.now(),
  ): void {
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.now = now;
  }

  isConfigured(): boolean {
    return (
      !!this.config.googleCalendarClientId &&
      !!this.config.googleCalendarClientSecret
    );
  }

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.googleCalendarClientId,
      redirect_uri: this.config.googleCalendarRedirectUri,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
      access_type: 'offline',
      // Without consent Google omits the refresh token on a second connect.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<{
    credentials: CalendarCredentials;
    accountEmail: string | null;
  }> {
    const body = await this.postForm(TOKEN_URL, {
      code,
      client_id: this.config.googleCalendarClientId,
      client_secret: this.config.googleCalendarClientSecret,
      redirect_uri: this.config.googleCalendarRedirectUri,
      grant_type: 'authorization_code',
    });
    const refreshToken =
      typeof body.refresh_token === 'string' ? body.refresh_token : '';
    const accessToken =
      typeof body.access_token === 'string' ? body.access_token : '';
    if (!refreshToken || !accessToken) {
      throw new CalendarAuthError(
        'Google did not return a refresh token. Remove the app from the Google account’s third-party access and connect again.',
      );
    }
    const expiresIn =
      typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.tokens.set(tokenCacheKey(refreshToken), {
      accessToken,
      expiresAtMs: this.now() + expiresIn * 1000,
    });

    let accountEmail: string | null = null;
    try {
      const info = await this.getJson(USERINFO_URL, accessToken);
      accountEmail = typeof info.email === 'string' ? info.email : null;
    } catch {
      // The email is a label for the console, not a requirement.
    }
    return { credentials: { refreshToken }, accountEmail };
  }

  async busyIntervals(
    credentials: CalendarCredentials,
    calendarId: string,
    fromMs: number,
    toMs: number,
  ): Promise<Interval[]> {
    const accessToken = await this.accessToken(credentials);
    const res = await this.request(`${CAL_BASE}/freeBusy`, {
      method: 'POST',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify({
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const body = (await this.readJson(res)) as {
      calendars?: Record<
        string,
        { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
      >;
    };
    const cal = body.calendars?.[calendarId];
    if (cal?.errors && cal.errors.length > 0) {
      throw new CalendarUnavailableError(
        `freeBusy reported errors for ${calendarId}`,
      );
    }
    return (cal?.busy ?? [])
      .map((b) => ({ startMs: Date.parse(b.start), endMs: Date.parse(b.end) }))
      .filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
  }

  async createEvent(
    credentials: CalendarCredentials,
    calendarId: string,
    input: CalendarEventInput,
  ): Promise<CreatedCalendarEvent> {
    const accessToken = await this.accessToken(credentials);
    const event: Record<string, unknown> = {
      summary: input.summary,
      description: input.description,
      start: {
        dateTime: new Date(input.startMs).toISOString(),
        timeZone: input.timeZone,
      },
      end: {
        dateTime: new Date(input.endMs).toISOString(),
        timeZone: input.timeZone,
      },
      transparency: 'opaque',
      status: 'confirmed',
    };
    if (input.attendeeEmail) event.attendees = [{ email: input.attendeeEmail }];
    if (input.withVideoMeeting) {
      event.conferenceData = {
        createRequest: {
          requestId: input.requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      };
    }

    const url = `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`;
    const res = await this.request(url, {
      method: 'POST',
      headers: this.jsonHeaders(accessToken),
      body: JSON.stringify(event),
    });
    const created = (await this.readJson(res)) as GoogleEvent;
    if (!created.id) {
      throw new CalendarUnavailableError('Google returned an event with no id');
    }

    let meetingUrl = pickMeetLink(created);
    if (input.withVideoMeeting && !meetingUrl) {
      for (
        let attempt = 0;
        attempt < MEET_LINK_RETRIES && !meetingUrl;
        attempt += 1
      ) {
        await this.sleep(600 + attempt * 500);
        try {
          const again = (await this.getJson(
            `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(created.id)}?conferenceDataVersion=1`,
            accessToken,
          )) as GoogleEvent;
          meetingUrl = pickMeetLink(again);
        } catch {
          // keep trying until the retries run out
        }
      }
    }
    return { eventId: created.id, meetingUrl };
  }

  async deleteEvent(
    credentials: CalendarCredentials,
    calendarId: string,
    eventId: string,
  ): Promise<void> {
    const accessToken = await this.accessToken(credentials);
    const res = await this.request(
      `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await this.readJson(res);
    }
  }

  async revoke(credentials: CalendarCredentials): Promise<void> {
    this.tokens.delete(tokenCacheKey(credentials.refreshToken));
    try {
      await this.request(
        `${REVOKE_URL}?token=${encodeURIComponent(credentials.refreshToken)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );
    } catch {
      // Disconnecting must succeed locally even if Google is unreachable.
    }
  }

  // --- internals ---------------------------------------------------------

  private async accessToken(credentials: CalendarCredentials): Promise<string> {
    const key = tokenCacheKey(credentials.refreshToken);
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAtMs - EXPIRY_MARGIN_MS > this.now()) {
      return cached.accessToken;
    }
    const body = await this.postForm(TOKEN_URL, {
      refresh_token: credentials.refreshToken,
      client_id: this.config.googleCalendarClientId,
      client_secret: this.config.googleCalendarClientSecret,
      grant_type: 'refresh_token',
    });
    if (typeof body.access_token !== 'string') {
      throw new CalendarUnavailableError(
        'Google token refresh returned no access token',
      );
    }
    const expiresIn =
      typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.tokens.set(key, {
      accessToken: body.access_token,
      expiresAtMs: this.now() + expiresIn * 1000,
    });
    return body.access_token;
  }

  private async postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return (await this.readJson(res)) as Record<string, unknown>;
  }

  private async getJson(
    url: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const res = await this.request(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return (await this.readJson(res)) as Record<string, unknown>;
  }

  private jsonHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // Status handling is the caller's (readJson or an explicit check): this only
      // turns a network failure or timeout into CalendarUnavailableError.
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      throw new CalendarUnavailableError(
        `Google Calendar request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Turns a response into JSON or the right error. A dead grant
   * (`invalid_grant`, or 401 on a calendar call) is CalendarAuthError; any
   * other failure is CalendarUnavailableError.
   */
  private async readJson(res: Response): Promise<unknown> {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok) return body ?? {};
    const record = (body ?? {}) as {
      error?: string | { message?: string; status?: string };
      error_description?: string;
    };
    const code =
      typeof record.error === 'string'
        ? record.error
        : (record.error?.status ?? '');
    const message =
      record.error_description ??
      (typeof record.error === 'object' ? record.error?.message : undefined) ??
      `HTTP ${res.status}`;
    if (code === 'invalid_grant' || res.status === 401) {
      throw new CalendarAuthError(message);
    }
    throw new CalendarUnavailableError(message);
  }
}
