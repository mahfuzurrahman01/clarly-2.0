import type { Pool } from 'pg';
import type { AppConfigService } from '../core/config/app-config.service';
import type { AppLoggerService } from '../core/logger/app-logger.service';
import { pgPoolProvider } from './persistence.providers';

type PoolFactory = (config: AppConfigService, logger: AppLoggerService) => Pool;

function makePool(): { pool: Pool; error: jest.Mock } {
  const error = jest.fn();
  const logger = { error, warn: jest.fn() } as unknown as AppLoggerService;
  const config = {
    databaseUrl: 'postgres://user:pass@127.0.0.1:1/none',
  } as unknown as AppConfigService;
  const factory = (pgPoolProvider as { useFactory: PoolFactory }).useFactory;
  return { pool: factory(config, logger), error };
}

describe('pgPoolProvider', () => {
  // node-postgres re-emits an idle client's connection error on the pool, and
  // an unhandled 'error' event crashes the Node process. Found by the L2 eval
  // (2026-09-29): a dropped Supabase connection killed the whole process
  // mid-run with "Connection terminated unexpectedly" — in production that is
  // the API going down on one network blip.
  it('handles idle-client errors instead of crashing the process', async () => {
    const { pool, error } = makePool();

    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      pool.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Connection terminated unexpectedly'),
      expect.anything(),
      'PgPool',
    );

    await pool.end();
  });

  // The pool's own 'error' listener only covers IDLE clients. A socket error on
  // a checked-out client with no query in flight (e.g. between the statements
  // of a transaction) is emitted on the client itself — seen in the same eval
  // as "read ETIMEDOUT" killing the process a second time.
  it('gives every new client an error listener so a checked-out client cannot crash the process', async () => {
    const { pool, error } = makePool();
    const { EventEmitter } = await import('node:events');
    const client = new EventEmitter();

    pool.emit('connect', client);

    expect(client.listenerCount('error')).toBeGreaterThan(0);
    expect(() =>
      client.emit('error', new Error('read ETIMEDOUT')),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('read ETIMEDOUT'),
      expect.anything(),
      'PgPool',
    );

    await pool.end();
  });
});
