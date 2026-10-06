// Feature 20 (Product Catalog & Stock): module for product catalog management.
// Provides REST API for CRUD, CSV import/export, and the lookup_product agent tool.
import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CoreModule } from '../core';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { StorageModule } from '../storage/storage.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { CatalogImportService } from './catalog-import.service';
import { CatalogImageService } from './catalog-image.service';
import { CatalogProductExecutor } from './catalog-product-executor';
import { CatalogToolSeederService } from './catalog-tool-seeder.service';

export { CatalogService } from './catalog.service';
export { CatalogImportService } from './catalog-import.service';
export { CatalogImageService } from './catalog-image.service';
export { CatalogProductExecutor } from './catalog-product-executor';
export { CatalogToolSeederService } from './catalog-tool-seeder.service';
export { lookupProductToolDefinition } from './catalog-product.tool';
export type { LookupProductInput } from './catalog-product.tool';
export type { ProductLookupResult } from './catalog-product-executor';

@Module({
  imports: [
    CoreModule,
    TenantContextModule,
    AuthModule,
    BillingModule,
    ToolRegistryModule,
    // F20 product photos reuse the platform object-storage port (the same
    // one KB documents and inbound WhatsApp media go through) rather than a
    // catalog-local storage abstraction.
    StorageModule,
  ],
  controllers: [CatalogController],
  providers: [
    CatalogService,
    CatalogImportService,
    CatalogImageService,
    CatalogProductExecutor,
    CatalogToolSeederService,
  ],
  exports: [
    CatalogService,
    CatalogImportService,
    CatalogImageService,
    CatalogProductExecutor,
    CatalogToolSeederService,
  ],
})
export class CatalogModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(CatalogController);
  }
}
