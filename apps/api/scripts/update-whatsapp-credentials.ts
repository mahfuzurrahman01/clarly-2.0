// One-off: attaches a real Meta Cloud API number (e.g. the App Dashboard's
// API Setup test number) to a tenant, so local testing can run webhook →
// agent → phone without Embedded Signup. Per-tenant credentials live
// encrypted in whatsapp_numbers.bsp_credentials_encrypted (D14/T3) — never in
// env vars; the shared Meta app secret/verify token/app id are the only
// env-level Meta config (apps/api/.env: META_APP_ID/META_APP_SECRET/META_VERIFY_TOKEN).
//
// Usage (all values from the shell, never hardcoded):
//   TENANT_ID=... META_DEV_PHONE_NUMBER_ID=... META_DEV_WABA_ID=... \
//   META_DEV_ACCESS_TOKEN=... pnpm exec ts-node --files -r tsconfig-paths/register \
//   scripts/update-whatsapp-credentials.ts
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { whatsappNumbers } from '../src/modules/persistence/drizzle/schema';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { BspCredentialsEncryptionService } from '../src/modules/whatsapp/bsp-credentials-encryption.service';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} in the shell env before running this script — never hardcode it in source.`);
  }
  return value;
}

async function main() {
  const tenantId = requireEnv('TENANT_ID');
  const phoneNumberId = requireEnv('META_DEV_PHONE_NUMBER_ID');
  const accessToken = requireEnv('META_DEV_ACCESS_TOKEN');
  const wabaId = process.env.META_DEV_WABA_ID ?? null;

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const persistence = app.get(PersistenceService);
    const encryption = app.get(BspCredentialsEncryptionService);
    const values = {
      phoneNumberId,
      wabaId,
      bspCredentialsEncrypted: encryption.encrypt({ accessToken }),
      connectionState: 'active' as const,
    };

    const result = await persistence.runAdminQuery((db) =>
      db
        .insert(whatsappNumbers)
        .values({ tenantId, ...values })
        .onConflictDoUpdate({ target: whatsappNumbers.phoneNumberId, set: { tenantId, ...values } })
        .returning({ id: whatsappNumbers.id, phoneNumberId: whatsappNumbers.phoneNumberId }),
    );

    console.log(`whatsapp_number   upserted (${result[0].phoneNumberId}) for tenant ${tenantId} — credentials encrypted`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
