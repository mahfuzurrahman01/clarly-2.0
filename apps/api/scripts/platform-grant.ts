/**
 * Clarly 2.0 S1: grant, change or revoke an operator (platform console) role.
 *
 * Like comp-tenant.ts, a script on purpose for the FIRST operator: there is no
 * one yet who could grant it through the console. Later grants can still be
 * done here; the console's own grant screen (S5) is owner-only.
 *
 * The user must already exist in Supabase Auth (sign up once through the
 * console, or invite them). Pass their auth user id (Supabase → Authentication
 * → Users → copy UID) and email.
 *
 * Usage:
 *   pnpm --filter api run platform:grant --user-id <uuid> --email ops@example.com --role owner
 *   pnpm --filter api run platform:grant --user-id <uuid> --revoke
 *   pnpm --filter api run platform:grant --list
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from '../src/modules/core/core.module';
import { PersistenceModule } from '../src/modules/persistence/persistence.module';
import {
  PLATFORM_ROLES,
  type PlatformRole,
} from '../src/modules/persistence/drizzle/schema';
import { PlatformAdminService } from '../src/modules/platform/platform-admin.service';

/**
 * Only what the script touches. Booting the whole AppModule (as comp-tenant.ts
 * does) also starts every BullMQ worker, whose Redis connections then throw
 * "Connection is closed" on shutdown and fail the run after it succeeded.
 */
@Module({
  imports: [CoreModule, PersistenceModule],
  providers: [PlatformAdminService],
})
class PlatformGrantModule {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flags(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out.set(flag.slice(2), true);
    else {
      out.set(flag.slice(2), next);
      i += 1;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = flags(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(PlatformGrantModule, {
    logger: ['error', 'warn'],
  });
  try {
    const admins = app.get(PlatformAdminService);

    if (f.get('list') === true) {
      for (const a of await admins.list()) {
        console.log(`${a.role.padEnd(7)} ${a.email}  ${a.userId}`);
      }
      return;
    }

    const userId = f.get('user-id');
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      throw new Error('--user-id <supabase auth uuid> is required.');
    }

    if (f.get('revoke') === true) {
      const removed = await admins.revoke(userId);
      console.log(
        removed ? `revoked ${userId}` : `${userId} was not an operator`,
      );
      return;
    }

    const email = f.get('email');
    const role = f.get('role');
    if (typeof email !== 'string' || !email.includes('@')) {
      throw new Error('--email <address> is required.');
    }
    if (
      typeof role !== 'string' ||
      !(PLATFORM_ROLES as readonly string[]).includes(role)
    ) {
      throw new Error(`--role must be one of: ${PLATFORM_ROLES.join(', ')}`);
    }

    const granted = await admins.grant({
      userId,
      email,
      role: role as PlatformRole,
      grantedBy: null,
    });
    console.log(`${granted.email} is now platform ${granted.role}`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
