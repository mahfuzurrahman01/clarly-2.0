import {
  ALLOW_REMOTE_DB_ENV,
  assertLocalIntegrationDatabase,
} from './db-guard';

const REMOTE_URL =
  'postgresql://app_user.abcdref:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres';

describe('assertLocalIntegrationDatabase', () => {
  it.each([
    'postgres://app_user:app_password@localhost:5432/whatsapp_ai_agent',
    'postgres://app_user:app_password@127.0.0.1:5432/whatsapp_ai_agent',
    'postgres://app_user:app_password@[::1]:5432/whatsapp_ai_agent',
    'postgres://app_user:app_password@LOCALHOST/whatsapp_ai_agent',
  ])('accepts a local database: %s', (url) => {
    expect(() =>
      assertLocalIntegrationDatabase({ DATABASE_URL: url }),
    ).not.toThrow();
  });

  it('refuses a remote database and names the host, never the credentials', () => {
    let message = '';
    try {
      assertLocalIntegrationDatabase({ DATABASE_URL: REMOTE_URL });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('aws-0-ap-northeast-1.pooler.supabase.com');
    expect(message).toContain(ALLOW_REMOTE_DB_ENV);
    expect(message).not.toContain('secret');
  });

  it('refuses a hostname that merely starts with localhost', () => {
    expect(() =>
      assertLocalIntegrationDatabase({
        DATABASE_URL: 'postgres://u:p@localhost.evil.example:5432/db',
      }),
    ).toThrow(/refusing to run/i);
  });

  it('allows a remote database only with the explicit override set to 1', () => {
    expect(() =>
      assertLocalIntegrationDatabase({
        DATABASE_URL: REMOTE_URL,
        [ALLOW_REMOTE_DB_ENV]: '1',
      }),
    ).not.toThrow();
    expect(() =>
      assertLocalIntegrationDatabase({
        DATABASE_URL: REMOTE_URL,
        [ALLOW_REMOTE_DB_ENV]: 'true',
      }),
    ).toThrow(/refusing to run/i);
  });

  it('refuses when DATABASE_URL is missing or unparseable', () => {
    expect(() => assertLocalIntegrationDatabase({})).toThrow(/DATABASE_URL/);
    expect(() =>
      assertLocalIntegrationDatabase({ DATABASE_URL: 'not a url' }),
    ).toThrow(/DATABASE_URL/);
  });
});
