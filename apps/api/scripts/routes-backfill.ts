/**
 * Clarly 2.0: fill `courier_routes` and `store_routes` (migration 0073) from
 * connections that were active before those tables existed.
 *
 * Courier pushes and store webhooks find their tenant through these routes.
 * New connects write them automatically; this one-off covers the rest. It
 * walks every open tenant and rebuilds that tenant's routes inside its own
 * tenant transaction, so it works with the normal (NOBYPASSRLS) app role.
 * Idempotent — safe to run again.
 *
 * Usage: pnpm --filter api run routes:backfill
 */
import 'dotenv/config';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from '../src/modules/core/core.module';
import { PersistenceModule } from '../src/modules/persistence/persistence.module';
import { TenantContextModule } from '../src/modules/tenant-context/tenant-context.module';
import { TenantDirectoryService } from '../src/modules/tenant-context/tenant-directory';
import { CourierConnectionService } from '../src/modules/courier/courier-connection.service';
import { StoreConnectionService } from '../src/modules/store/store-connection.service';
import { BspCredentialsEncryptionService } from '../src/modules/whatsapp/bsp-credentials-encryption.service';

/** Only what the script touches — not AppModule, whose BullMQ workers would start. */
@Module({
  imports: [CoreModule, PersistenceModule, TenantContextModule],
  providers: [
    BspCredentialsEncryptionService,
    CourierConnectionService,
    StoreConnectionService,
  ],
})
class RoutesBackfillModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RoutesBackfillModule, {
    logger: ['error', 'warn'],
  });
  try {
    const tenants = await app.get(TenantDirectoryService).listTenantIds();
    const couriers = app.get(CourierConnectionService);
    const stores = app.get(StoreConnectionService);
    let courierRoutes = 0;
    let storeRoutes = 0;
    for (const tenantId of tenants) {
      courierRoutes += await couriers.rebuildRoutes(tenantId);
      storeRoutes += await stores.rebuildRoutes(tenantId);
    }
    console.log(
      `routes:backfill — ${tenants.length} tenant(s), ${courierRoutes} courier route(s), ${storeRoutes} store route(s)`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
