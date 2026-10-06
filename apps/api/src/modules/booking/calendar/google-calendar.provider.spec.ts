import type { AppConfigService } from '../../core';
import {
  CalendarAuthError,
  CalendarUnavailableError,
} from './calendar-provider.port';
import {
  GoogleCalendarProvider,
  pickMeetLink,
} from './google-calendar.provider';

const config = {
  googleCalendarClientId: 'client-id',
  googleCalendarClientSecret: 'client-secret',
  googleCalendarRedirectUri:
    'https://api.example.com/bookings/calendar/callback',
} as AppConfigService;

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = jest.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: url instanceof Request ? url.url : url.toString(),
      init: init ?? {},
    });
    const next = responses.shift() ?? { status: 500, body: {} };
    const status = next.status ?? 200;
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const CREDS = { refreshToken: 'refresh-1' };
const TOKEN = { body: { access_token: 'access-1', expires_in: 3600 } };

describe('GoogleCalendarProvider', () => {
  it('builds an offline, consent-prompting auth URL with the calendar scopes', () => {
    const url = new URL(
      new GoogleCalendarProvider(config).buildAuthUrl('state-1'),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toContain('calendar.events');
    expect(url.searchParams.get('scope')).toContain('calendar.freebusy');
  });

  it('exchanges a code and reads the account email', async () => {
    const p = new GoogleCalendarProvider(config);
    const { fn } = fakeFetch([
      { body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } },
      { body: { email: 'clinic@example.com' } },
    ]);
    p.useTransport(fn);
    await expect(p.exchangeCode('code-1')).resolves.toEqual({
      credentials: { refreshToken: 'r' },
      accountEmail: 'clinic@example.com',
    });
  });

  it('refuses a token response with no refresh token', async () => {
    const p = new GoogleCalendarProvider(config);
    p.useTransport(fakeFetch([{ body: { access_token: 'a' } }]).fn);
    await expect(p.exchangeCode('code-1')).rejects.toBeInstanceOf(
      CalendarAuthError,
    );
  });

  // The 7-day refresh token of an unverified app, or a revoked grant.
  it('reports invalid_grant on refresh as CalendarAuthError', async () => {
    const p = new GoogleCalendarProvider(config);
    p.useTransport(
      fakeFetch([
        {
          status: 400,
          body: {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          },
        },
      ]).fn,
    );
    await expect(
      p.busyIntervals(CREDS, 'primary', 0, 1),
    ).rejects.toBeInstanceOf(CalendarAuthError);
  });

  it('parses free/busy blocks and caches the access token', async () => {
    const p = new GoogleCalendarProvider(config);
    const { fn, calls } = fakeFetch([
      TOKEN,
      {
        body: {
          calendars: {
            primary: {
              busy: [
                { start: '2026-10-08T10:00:00Z', end: '2026-10-08T11:00:00Z' },
              ],
            },
          },
        },
      },
      { body: { calendars: { primary: { busy: [] } } } },
    ]);
    p.useTransport(fn);
    await expect(p.busyIntervals(CREDS, 'primary', 0, 1)).resolves.toEqual([
      {
        startMs: Date.parse('2026-10-08T10:00:00Z'),
        endMs: Date.parse('2026-10-08T11:00:00Z'),
      },
    ]);
    await p.busyIntervals(CREDS, 'primary', 0, 1);
    expect(
      calls.filter((c) => c.url.includes('oauth2.googleapis.com/token')),
    ).toHaveLength(1);
  });

  it('treats calendar-level freeBusy errors as unavailable, not as "free"', async () => {
    const p = new GoogleCalendarProvider(config);
    p.useTransport(
      fakeFetch([
        TOKEN,
        {
          body: {
            calendars: { primary: { errors: [{ reason: 'notFound' }] } },
          },
        },
      ]).fn,
    );
    await expect(
      p.busyIntervals(CREDS, 'primary', 0, 1),
    ).rejects.toBeInstanceOf(CalendarUnavailableError);
  });

  it('creates an opaque event and waits for the asynchronous Meet link', async () => {
    const p = new GoogleCalendarProvider(config);
    const { fn, calls } = fakeFetch([
      TOKEN,
      {
        body: {
          id: 'evt-1',
          conferenceData: {
            createRequest: { status: { statusCode: 'pending' } },
          },
        },
      },
      { body: { id: 'evt-1' } },
      {
        body: {
          id: 'evt-1',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
        },
      },
    ]);
    p.useTransport(fn);
    const result = await p.createEvent(CREDS, 'primary', {
      summary: 'Consultation — Sara',
      description: 'Booking BK-1',
      startMs: Date.parse('2026-10-08T10:00:00Z'),
      endMs: Date.parse('2026-10-08T10:30:00Z'),
      timeZone: 'Asia/Riyadh',
      withVideoMeeting: true,
      attendeeEmail: 'sara@example.com',
      requestId: 'abc123',
    });
    expect(result).toEqual({
      eventId: 'evt-1',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    });
    const create = calls[1];
    expect(create.url).toContain('sendUpdates=all');
    const body = JSON.parse(create.init.body as string) as Record<
      string,
      unknown
    >;
    expect(body.transparency).toBe('opaque');
    expect(body.attendees).toEqual([{ email: 'sara@example.com' }]);
  });

  it('treats an already-deleted event as deleted', async () => {
    const p = new GoogleCalendarProvider(config);
    p.useTransport(fakeFetch([TOKEN, { status: 410, body: {} }]).fn);
    await expect(
      p.deleteEvent(CREDS, 'primary', 'evt-1'),
    ).resolves.toBeUndefined();
  });

  it('picks the video entry point when there is no hangoutLink', () => {
    expect(
      pickMeetLink({
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:1' },
            { entryPointType: 'video', uri: 'https://meet.google.com/x' },
          ],
        },
      }),
    ).toBe('https://meet.google.com/x');
  });
});
