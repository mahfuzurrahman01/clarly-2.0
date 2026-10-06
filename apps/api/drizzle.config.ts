// drizzle-kit CLI config (db:generate / db:migrate / db:push / db:studio).
// Reads DATABASE_URL directly from the environment — drizzle-kit runs
// outside Nest's DI container, so it can't go through AppConfigService.
// This is the one place other than persistence.providers.ts allowed to read
// DATABASE_URL raw, per PersistenceModule owning the connection boundary.
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run drizzle-kit commands.');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/persistence/drizzle/schema.ts',
  out: './src/modules/persistence/drizzle/migrations',
  dbCredentials: {
    url: databaseUrl,
  },
  verbose: true,
  strict: true,
});
