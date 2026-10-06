import { corsOptionsFor } from './cors';

describe('corsOptionsFor', () => {
  const consoleOrigins = ['https://app.clarly.ai'];

  it('reflects any origin on the public widget endpoints, without credentials or auth headers', () => {
    const opts = corsOptionsFor('/widget/v1/config?key=wk_x', consoleOrigins);
    expect(opts.origin).toBe(true);
    expect(opts.credentials).toBe(false);
    expect(opts.allowedHeaders).toEqual(['Content-Type']);
    expect(opts.methods).toEqual(['GET', 'POST', 'OPTIONS']);
  });

  it('keeps every other route on the console allow-list', () => {
    expect(corsOptionsFor('/widget', consoleOrigins).origin).toEqual(
      consoleOrigins,
    );
    expect(corsOptionsFor('/inbox', consoleOrigins).origin).toEqual(
      consoleOrigins,
    );
  });

  it('does not treat a look-alike path as the widget', () => {
    expect(corsOptionsFor('/widget/v10/config', consoleOrigins).origin).toEqual(
      consoleOrigins,
    );
    expect(
      corsOptionsFor('/api/widget/v1/config', consoleOrigins).origin,
    ).toEqual(consoleOrigins);
  });

  it('disables CORS for the console when no origins are configured', () => {
    expect(corsOptionsFor('/inbox', []).origin).toBe(false);
  });
});
