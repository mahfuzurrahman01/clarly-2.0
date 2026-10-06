// Feature 24 (Store Integrations): OAuth flow orchestration service.
// initiate (signed state) → provider redirect → callback (state verified,
// tenant derived FROM the state) → token exchange → encrypted connection row.
//
// The tenant NEVER comes from the callback request's query string. That was
// the first cut's cross-tenant store-hijack: `?tenant_id=<any uuid>` on an
// unauthenticated callback attached an arbitrary store to an arbitrary
// workspace.
import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StoreConnectionService,
  type StoreConnection,
} from './store-connection.service';
import {
  InvalidStoreConnectStateError,
  StoreOAuthStateService,
} from './store-oauth-state.service';
import { StoreProviderRegistry } from './store-provider.registry';
import { AppConfigService, AppLoggerService } from '../core';
import type { StoreProviderName } from './store-provider-name';
import type { StoreOAuthCallbackContext } from './ports/store-provider.port';

export interface StoreCallbackResult {
  connectionId: string;
  storeName: string;
  tenantId: string;
  /** False when subscribing the store's webhooks failed. The connection exists either way. */
  webhooksRegistered: boolean;
}

/** What an adapter call needs from a connection, after any refresh. */
export interface StoreCredentials {
  accessToken: string;
  /** Zid's partner token (StoreTokens.authorizationToken); undefined for every other provider. */
  authorizationToken?: string;
}

@Injectable()
export class StoreOAuthService {
  constructor(
    private readonly connectionService: StoreConnectionService,
    private readonly stateService: StoreOAuthStateService,
    private readonly registry: StoreProviderRegistry,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
  ) {}

  /** Called from the authenticated console — `tenantId` comes from the bearer token and is sealed into the signed state. */
  initiateOAuth(
    tenantId: string,
    provider: StoreProviderName,
    context?: StoreOAuthCallbackContext,
  ): { authorizeUrl: string; state: string } {
    // The provider is chosen per tenant at runtime, so "are this provider's
    // OAuth app credentials present?" cannot be a boot-time refine (see the
    // Feature 24 block in env.schema.ts). Check it here instead: without it
    // an unconfigured provider yields an authorize URL with an empty
    // client_id, and the merchant discovers the misconfiguration as an
    // opaque error page on the provider's own domain.
    if (!this.config.isStoreProviderConfigured(provider)) {
      throw new ServiceUnavailableException(
        `Store provider "${provider}" is not configured on this deployment.`,
      );
    }

    // The merchant's own host (WooCommerce site, Shopify shop) is sealed into
    // the signed state here, while the request is still authenticated.
    // Nothing on the callback may change it. The adapter validates the host
    // before it is signed.
    const adapter = this.registry.forProvider(provider);
    const binding = adapter.connectBinding(context);
    const state = this.stateService.sign(tenantId, provider, binding);
    const authorizeUrl = adapter.getOAuthAuthorizeUrl(state, {
      ...context,
      ...binding,
    });
    this.logger.log(
      `Store OAuth initiated for tenant ${tenantId}, provider ${provider}`,
      'StoreOAuthService',
    );
    return { authorizeUrl, state };
  }

  /**
   * Completes the flow. Throws InvalidStoreConnectStateError (mapped to a
   * rejected redirect by the controller) on a forged, expired, or
   * cross-provider state, or a bad provider callback signature — nothing is
   * written in that case.
   *
   * `callbackQuery` is the callback's FULL query string: a provider that
   * signs its callback (Shopify's `hmac`) signs every param, including ones
   * nothing else here reads.
   */
  async handleCallback(
    provider: StoreProviderName,
    code: string,
    state: string | undefined,
    context?: StoreOAuthCallbackContext,
    callbackQuery: Readonly<Record<string, unknown>> = {},
  ): Promise<StoreCallbackResult> {
    const adapter = this.registry.forProvider(provider);
    if (!adapter.verifyCallbackSignature(callbackQuery)) {
      throw new InvalidStoreConnectStateError(
        new Error(`${provider} callback signature is invalid.`),
      );
    }

    const verified = await this.stateService.verify(state, provider);
    const { tenantId } = verified;

    // The signed state's host wins over anything the callback asserted — for
    // WooCommerce it is the ONLY trustworthy source (the site's callback POST
    // never names itself). For Shopify the callback also echoes `?shop=`; a
    // value that disagrees with the sealed one is a tampered redirect.
    if (verified.shop && context?.shop && context.shop !== verified.shop) {
      throw new InvalidStoreConnectStateError(
        new Error('Shopify callback shop does not match the connect state.'),
      );
    }
    const resolvedContext: StoreOAuthCallbackContext = {
      ...context,
      siteUrl: verified.siteUrl ?? context?.siteUrl,
      shop: verified.shop ?? context?.shop,
    };

    const tokens = await adapter.exchangeCode(code, resolvedContext);
    // Minted here so the webhook path always has a real secret to verify
    // against for the providers that authenticate with a per-connection one.
    // Salla: the merchant reads it once via POST
    // /store/connections/:id/webhook-secret. Zid: it is the Basic-auth
    // password registerWebhooks() subscribes with.
    const webhookSecret = StoreConnectionService.generateWebhookSecret();
    const connection = await this.connectionService.create({
      tenantId,
      provider,
      storeId: tokens.storeId,
      storeName: tokens.storeName,
      storeUrl: tokens.storeUrl,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      authorizationToken: tokens.authorizationToken,
      tokenExpiresAt: tokens.expiresAt,
      webhookSecret,
    });

    // Best-effort: the store is connected either way, and the scheduled sync
    // sweep still runs without webhooks. A failure is logged and reported in
    // the result (the callback redirect carries it), never thrown.
    let webhooksRegistered = true;
    try {
      await adapter.registerWebhooks(
        tokens.accessToken,
        { ...resolvedContext, authorizationToken: tokens.authorizationToken },
        { storeId: tokens.storeId, webhookSecret },
      );
    } catch (err) {
      webhooksRegistered = false;
      this.logger.error(
        `Store webhook registration failed for connection ${connection.id} (${provider}): ${err instanceof Error ? err.message : String(err)}`,
        'StoreOAuthService',
      );
    }

    this.logger.log(
      `Store OAuth callback completed for tenant ${tenantId}, provider ${provider}, store ${tokens.storeName}`,
      'StoreOAuthService',
    );
    return {
      connectionId: connection.id,
      storeName: tokens.storeName,
      tenantId,
      webhooksRegistered,
    };
  }

  /**
   * Returns a usable access token for this connection (plus Zid's partner
   * `authorization` token), refreshing first when the stored one is expired
   * or about to be. Both come from the same refresh, so the pair never mixes
   * an old and a new token. Always returns a token (or throws) — the first
   * cut returned '' on the happy path, which callers then silently fell back
   * from.
   */
  async ensureCredentials(
    connection: StoreConnection,
  ): Promise<StoreCredentials> {
    const stored: StoreCredentials = {
      accessToken: connection.accessToken,
      authorizationToken: connection.authorizationToken ?? undefined,
    };
    const expiresAt = connection.tokenExpiresAt;
    const needsRefresh =
      !!expiresAt && expiresAt.getTime() - Date.now() < 60_000;
    if (!needsRefresh || !connection.refreshToken) {
      return stored;
    }

    const refreshed = await this.registry
      .forProvider(connection.provider)
      .refreshAccessToken(connection.refreshToken);
    if (!refreshed) {
      // Provider has no refresh grant (Shopify offline tokens) — the stored
      // token remains the valid one.
      return stored;
    }

    await this.connectionService.updateTokens(
      connection.tenantId,
      connection.id,
      {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? null,
        expiresAt: refreshed.expiresAt ?? null,
        // Only Zid returns one; absent means "keep the stored value".
        ...(refreshed.authorizationToken
          ? { authorizationToken: refreshed.authorizationToken }
          : {}),
      },
    );
    return {
      accessToken: refreshed.accessToken,
      authorizationToken:
        refreshed.authorizationToken ?? stored.authorizationToken,
    };
  }

  async disconnect(tenantId: string, connectionId: string): Promise<void> {
    const disconnected = await this.connectionService.markDisconnected(
      tenantId,
      connectionId,
    );
    if (!disconnected) {
      // Same message for "does not exist" and "belongs to another tenant" —
      // no existence oracle across workspaces.
      throw new NotFoundException('Store connection not found');
    }
    this.logger.log(
      `Store disconnected: ${connectionId} for tenant ${tenantId}`,
      'StoreOAuthService',
    );
  }
}
