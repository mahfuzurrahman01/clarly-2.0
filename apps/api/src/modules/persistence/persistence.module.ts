import { Module } from '@nestjs/common';
import {
  pgPoolProvider,
  drizzleDbProvider,
  PG_POOL,
  DRIZZLE_DB,
} from './persistence.providers';
import { PersistenceService } from './persistence.service';

// Platform: Drizzle, migrations, pgvector types (T5). Enforced rule 4: only
// PersistenceModule/TenantContextModule may open a raw DB connection.
//
// PG_POOL/DRIZZLE_DB are exported so TenantContextModule (the only other
// permitted consumer) can build withTenantTx() on top of the same pool —
// every other module must go through TenantContextModule, never import this
// module directly. That boundary is lint-enforced, see
// docs/decisions/F0-ci-test-strategy.md.
@Module({
  imports: [],
  controllers: [],
  providers: [pgPoolProvider, drizzleDbProvider, PersistenceService],
  exports: [PG_POOL, DRIZZLE_DB, PersistenceService],
})
export class PersistenceModule {}
