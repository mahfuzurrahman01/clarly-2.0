// Platform (PersistenceModule): raw connection + Drizzle db instance.
// Enforced rule 4 ("nothing outside PersistenceModule/TenantContextModule
// opens a raw DB connection") is enforced two ways here, not just by
// comment: (1) this file is the *only* place a `pg.Pool` is constructed in
// the app, and (2) apps/api/eslint.config.mjs bans importing `pg` /
// `drizzle-orm/node-postgres` from every module directory except
// `persistence` and `tenant-context`.
import { Pool, type PoolClient } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Provider } from '@nestjs/common';
import { AppConfigService } from '../core/config/app-config.service';
import { AppLoggerService } from '../core/logger/app-logger.service';
import * as schema from './drizzle/schema';

export const PG_POOL = Symbol('PG_POOL');
export const DRIZZLE_DB = Symbol('DRIZZLE_DB');

export type DrizzleDb = NodePgDatabase<typeof schema>;

export const pgPoolProvider: Provider = {
  provide: PG_POOL,
  useFactory: (config: AppConfigService, logger: AppLoggerService): Pool => {
    // Supavisor transaction-mode pooling in prod, plain Postgres in dev/CI —
    // see docs/decisions/F0-infra.md for why `max` stays modest: the pooler
    // in front of this already multiplexes connections, so this Pool's own
    // size just bounds how many concurrent server-side connections *this*
    // process can hold against the pooler.
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // node-postgres re-emits an IDLE client's error (the pooler or network
    // dropping the socket) on the pool, and an unhandled 'error' event crashes
    // the process. The pool has already discarded that client and will open a
    // fresh one on the next checkout, so logging is the whole job here. Found
    // by the L2 eval (2026-09-29): one dropped Supabase connection killed the
    // process with "Connection terminated unexpectedly". Errors on a client
    // that is checked out still reject that query as before.
    pool.on('error', (error: Error) => {
      logger.error(
        `idle Postgres client error (client discarded): ${error.message}`,
        error.stack,
        'PgPool',
      );
    });
    // The listener above only covers IDLE clients. A socket error on a
    // checked-out client with no query in flight (between a transaction's
    // statements) is emitted on the client itself, with no listener, and
    // crashed the process again in the same eval ("read ETIMEDOUT"). Every
    // client gets one at creation. Its next query still fails, so the caller
    // sees the error and the pool drops the broken client on release.
    pool.on('connect', (client: PoolClient) => {
      client.on('error', (error: Error) => {
        logger.error(
          `Postgres client error: ${error.message}`,
          error.stack,
          'PgPool',
        );
      });
    });
    return pool;
  },
  inject: [AppConfigService, AppLoggerService],
};

export const drizzleDbProvider: Provider = {
  provide: DRIZZLE_DB,
  useFactory: (pool: Pool): DrizzleDb => drizzle(pool, { schema }),
  inject: [PG_POOL],
};
