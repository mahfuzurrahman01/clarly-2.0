// F26 (D10 Contract): `pnpm --filter api test:courier-contract`.
//
// Pins each courier's response CONTRACT — the status strings, the field names
// and the envelope shape each adapter is written against — against the
// recorded fixtures. A vendor changing a status code becomes a failing test
// rather than a silent `unknown` shown to a customer.
//
// Kept out of the default suite (its own jest project, like
// `test:meta-contract`) because its job is different: the unit specs ask "is
// the adapter correct", this asks "is the vendor still doing what we recorded".
// When sandbox accounts arrive (F26 "Open items" #1), the fixtures are
// re-recorded from live responses and whatever was transcribed from
// documentation rather than observed fails here, loudly, at that moment.
//
// STATUS TODAY: every fixture is transcribed from published documentation.
// No connector in this repo has ever been called against a live courier.
import { AramexConnector } from '../src/modules/courier/ports/aramex.connector';
import { JtConnector } from '../src/modules/courier/ports/jt.connector';
import { NaqelConnector } from '../src/modules/courier/ports/naqel.connector';
import { SmsaConnector } from '../src/modules/courier/ports/smsa.connector';
import { SHIPMENT_STATUSES } from '../src/modules/persistence/drizzle/schema';
import {
  ARAMEX_TRACK_RESPONSE,
  JT_TRACE_RESPONSE,
  NAQEL_TRACK_RESPONSE,
  SMSA_TRACK_RESPONSE,
} from '../src/modules/courier/ports/__fixtures__/courier-responses';

function serveOnce(body: unknown): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

const CASES = [
  {
    courier: 'Aramex',
    fixture: ARAMEX_TRACK_RESPONSE,
    trackingNumber: '47384974350',
    credentials: {
      username: 'u',
      password: 'p',
      accountNumber: '1',
      accountPin: '2',
      accountEntity: 'RUH',
      accountCountryCode: 'SA',
    },
    connector: () => new AramexConnector(),
    expected: ['label_created', 'out_for_delivery', 'delivered'],
  },
  {
    courier: 'SMSA',
    fixture: SMSA_TRACK_RESPONSE,
    trackingNumber: '287654321098',
    credentials: { apiKey: 'k' },
    connector: () => new SmsaConnector(),
    expected: ['picked_up', 'in_transit', 'exception'],
  },
  {
    courier: 'Naqel',
    fixture: NAQEL_TRACK_RESPONSE,
    trackingNumber: '9900112233',
    credentials: { clientId: 'c', password: 'p' },
    connector: () => new NaqelConnector(),
    expected: ['picked_up', 'out_for_delivery', 'unknown'],
  },
  {
    courier: 'J&T',
    fixture: JT_TRACE_RESPONSE,
    trackingNumber: 'JT0000123456',
    credentials: { apiAccount: 'a', privateKey: 'k' },
    connector: () => new JtConnector(),
    expected: ['picked_up', 'out_for_delivery', 'unknown'],
  },
] as const;

describe.each(CASES)(
  '$courier tracking contract',
  ({ fixture, trackingNumber, credentials, connector, expected }) => {
    it('parses the recorded response into the platform status vocabulary', async () => {
      serveOnce(fixture);

      const results = await connector().track(credentials, [trackingNumber]);

      expect(results).toHaveLength(1);
      expect(results[0].trackingNumber).toBe(trackingNumber);
      expect(results[0].events.map((event) => event.status)).toEqual(expected);
    });

    it('emits only statuses the database CHECK constraint accepts', async () => {
      serveOnce(fixture);

      const results = await connector().track(credentials, [trackingNumber]);

      for (const event of results[0].events) {
        expect(SHIPMENT_STATUSES).toContain(event.status);
        // `occurred_at` is part of the history dedup key; an invalid date
        // would make every re-poll insert a "new" event.
        expect(Number.isNaN(event.occurredAt.getTime())).toBe(false);
        // The courier's own code is kept for support, never shown to the model.
        expect(typeof event.rawStatus).toBe('string');
      }
    });

    it('carries no courier free prose out of the adapter', async () => {
      serveOnce(fixture);

      const results = await connector().track(credentials, [trackingNumber]);

      const serialized = JSON.stringify(results);
      expect(serialized).not.toContain('IGNORE PREVIOUS INSTRUCTIONS');
    });
  },
);
