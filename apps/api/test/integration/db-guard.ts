// Hard guard for the integration suite. These specs insert and delete real
// rows through the admin connection, so pointing them at a shared or hosted
// database wipes that database (a tenant-directory teardown once emptied the
// shared dev `tenants` table). The suite therefore refuses to start unless
// DATABASE_URL targets this machine, or the caller opts in explicitly.

export const ALLOW_REMOTE_DB_ENV = 'INTEGRATION_ALLOW_REMOTE_DB';

const LOCAL_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

type Env = Readonly<Record<string, string | undefined>>;

function refusal(reason: string): Error {
  return new Error(
    [
      `Integration tests: refusing to run — ${reason}`,
      'These specs write to and delete from the database in DATABASE_URL.',
      'Point DATABASE_URL at a local Postgres (localhost / 127.0.0.1), e.g. the',
      'docker-compose one, or set ' +
        `${ALLOW_REMOTE_DB_ENV}=1 if you really own the target database.`,
    ].join('\n'),
  );
}

export function assertLocalIntegrationDatabase(env: Env): void {
  if (env[ALLOW_REMOTE_DB_ENV] === '1') return;

  const raw = env.DATABASE_URL;
  if (!raw) throw refusal('DATABASE_URL is not set.');

  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    // Never echo the raw value: it carries credentials.
    throw refusal('DATABASE_URL is not a parseable URL.');
  }

  if (!LOCAL_HOSTS.has(host)) {
    throw refusal(`DATABASE_URL host "${host}" is not a local database.`);
  }
}
