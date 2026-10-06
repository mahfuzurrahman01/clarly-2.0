// Feature 24 (Store Integrations): the authenticated store-management API.
// Admin-only workspace configuration, same tier as the WhatsApp connect API.
//
// `auth.tenantId` comes from the bearer token via TenantAuthMiddleware (wired
// in StoreModule.configure) — the first cut used @CurrentAuth() with no
// middleware applied to this controller at all, so every route 401'd.
import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CurrentAuth } from '../auth/current-auth.decorator';
import type { TenantAuthContext } from '../auth/jwt-claims';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { EntitlementGuard } from '../billing/entitlement.guard';
import { StoreOAuthService } from './store-oauth.service';
import { StoreConnectionService } from './store-connection.service';
import { StoreSyncJobService } from './store-sync-job.service';
import { isStoreProviderName } from './store-provider-name';

/** The outcome of this connection's most recent sync attempt. Null until one has run. */
export interface StoreSyncOutcomeDto {
  status: string;
  productsSynced: number;
  productsFailed: number;
  /** The provider/catalog failure, verbatim, so the merchant can act on it. Truncated at write time. */
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ConnectedStoreDto {
  id: string;
  provider: string;
  storeId: string;
  storeName: string;
  storeUrl: string | null;
  isActive: boolean;
  /** When the connection last synced SUCCESSFULLY. `lastSync` below says what happened on the last ATTEMPT. */
  lastSyncedAt: Date | null;
  lastSync: StoreSyncOutcomeDto | null;
}

@ApiTags('Store')
@ApiBearerAuth()
@UseGuards(RolesGuard, EntitlementGuard)
@Roles('admin')
@Controller('store')
export class StoreController {
  constructor(
    private readonly oauthService: StoreOAuthService,
    private readonly connectionService: StoreConnectionService,
    private readonly syncJobService: StoreSyncJobService,
  ) {}

  /** Start the OAuth flow. The returned `state` is signed and tenant-bound; the callback accepts nothing else. */
  @Post('connect/:provider')
  @ApiOperation({ summary: 'Initiate the OAuth flow for a store provider' })
  connect(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('provider') provider: string,
    @Query('shop') shop?: string,
    @Query('siteUrl') siteUrl?: string,
  ): { authorizeUrl: string; state: string } {
    if (!isStoreProviderName(provider)) {
      throw new BadRequestException('Unsupported store provider');
    }
    // `siteUrl` is WooCommerce's equivalent of Shopify's `shop`: the
    // merchant's own self-hosted site. It is required there, because
    // WooCommerce has no platform host to fall back to, and it is sealed into
    // the signed state so the unauthenticated key-delivery POST cannot choose
    // a different one.
    if (provider === 'woocommerce' && !siteUrl) {
      throw new BadRequestException(
        'Connecting WooCommerce requires the siteUrl query parameter (the merchant’s own store URL).',
      );
    }
    return this.oauthService.initiateOAuth(auth.tenantId, provider, {
      shop,
      siteUrl,
    });
  }

  /** Connected stores for this workspace. Never returns tokens or the webhook secret. */
  @Get('connections')
  @ApiOperation({ summary: "List the workspace's connected stores" })
  async listConnections(
    @CurrentAuth() auth: TenantAuthContext,
  ): Promise<ConnectedStoreDto[]> {
    const connections = await this.connectionService.findByTenant(
      auth.tenantId,
    );
    // One extra read per connection (a tenant has a handful at most) rather
    // than a window function, so the "latest job" rule lives in one indexed
    // query in StoreSyncJobService instead of being re-expressed here.
    return Promise.all(
      connections.map(async (c) => {
        const lastSync = await this.syncJobService.findLatestForConnection(
          auth.tenantId,
          c.id,
        );
        return {
          id: c.id,
          provider: c.provider,
          storeId: c.storeId,
          storeName: c.storeName,
          storeUrl: c.storeUrl,
          isActive: c.isActive,
          lastSyncedAt: c.lastSyncedAt,
          lastSync: lastSync
            ? {
                status: lastSync.status,
                productsSynced: lastSync.productsSynced,
                productsFailed: lastSync.productsFailed,
                errorMessage: lastSync.errorMessage,
                startedAt: lastSync.startedAt,
                completedAt: lastSync.completedAt,
              }
            : null,
        };
      }),
    );
  }

  /**
   * Rotates and reveals the per-connection webhook secret ONCE. The merchant
   * pastes it into their store's webhook settings; Salla webhooks are
   * verified against it, and an unverifiable webhook is rejected. Refused for
   * Zid: there the secret is the Basic-auth password subscribed by API at
   * connect time, so rotating it here would make Zid's deliveries fail until
   * the store is reconnected (which mints and re-subscribes a new one).
   */
  @Post('connections/:connectionId/webhook-secret')
  @ApiOperation({
    summary: 'Rotate and reveal this connection’s webhook secret (shown once)',
  })
  async rotateWebhookSecret(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('connectionId') connectionId: string,
  ): Promise<{ webhookSecret: string }> {
    const connection = await this.connectionService.findById(
      auth.tenantId,
      connectionId,
    );
    if (connection?.provider === 'zid') {
      throw new BadRequestException(
        'Zid webhook credentials are set automatically on connect; reconnect the store to rotate them',
      );
    }
    const secret = await this.connectionService.rotateWebhookSecret(
      auth.tenantId,
      connectionId,
    );
    if (!secret) {
      throw new BadRequestException('Store connection not found');
    }
    return { webhookSecret: secret };
  }

  @Post('disconnect/:connectionId')
  @ApiOperation({ summary: 'Disconnect a store' })
  async disconnect(
    @CurrentAuth() auth: TenantAuthContext,
    @Param('connectionId') connectionId: string,
  ): Promise<{ success: boolean }> {
    await this.oauthService.disconnect(auth.tenantId, connectionId);
    return { success: true };
  }
}
