// Platform (CoreModule): validated config service. Parses process.env once
// at construction (Nest instantiates providers at bootstrap) so a missing
// required var fails app startup, not a request three hours later.
import { Injectable } from '@nestjs/common';
import { type Env, parseEnv } from './env.schema';

/**
 * Feature 24: the store providers this deployment holds OAuth app credentials
 * for. Declared here rather than imported from `store/store-provider-name.ts`
 * so CoreModule keeps zero dependencies on feature modules; it is structurally
 * the same union as `StoreProviderName`, and the store module passes its own
 * values straight in.
 */
export type StoreProviderCredentialName =
  'salla' | 'zid' | 'shopify' | 'woocommerce';

@Injectable()
export class AppConfigService {
  private readonly env: Env;

  constructor() {
    this.env = parseEnv(process.env);
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get port(): number {
    return this.env.PORT;
  }

  /** Parsed allow-list for browser clients. Empty array means "no cross-origin access". */
  get corsOrigins(): string[] {
    return this.env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  get redisUrl(): string {
    return this.env.REDIS_URL;
  }

  /** QueueModule: worker polling profile ('lean' for metered/free Redis tiers). */
  get queueProfile(): Env['QUEUE_PROFILE'] {
    return this.env.QUEUE_PROFILE;
  }

  get supabaseJwtSecret(): string {
    return this.env.SUPABASE_JWT_SECRET;
  }

  get bspCredentialsEncryptionKey(): string {
    return this.env.BSP_CREDENTIALS_ENCRYPTION_KEY;
  }

  get bspProvider(): Env['BSP_PROVIDER'] {
    return this.env.BSP_PROVIDER;
  }

  get metaGraphBaseUrl(): string {
    return this.env.META_GRAPH_BASE_URL;
  }

  get metaGraphVersion(): string {
    return this.env.META_GRAPH_VERSION;
  }

  /**
   * The ONE Meta app secret (D8) — signs every inbound Meta webhook
   * (WhatsApp, Messenger, Instagram) and authenticates the app-level Graph
   * calls. `META_SOCIAL_APP_SECRET` is a deprecated alias for one release:
   * honoured only when META_APP_SECRET is unset. envSchema's refines make one
   * of them required whenever BSP_PROVIDER=meta or META_SOCIAL_CHANNELS_ENABLED.
   */
  get metaAppSecret(): string {
    return this.env.META_APP_SECRET ?? this.env.META_SOCIAL_APP_SECRET ?? '';
  }

  /** The ONE Meta webhook verify token (D8). `META_SOCIAL_VERIFY_TOKEN` is a deprecated alias, same rules as metaAppSecret. */
  get metaVerifyToken(): string {
    return (
      this.env.META_VERIFY_TOKEN ?? this.env.META_SOCIAL_VERIFY_TOKEN ?? ''
    );
  }

  /**
   * One human-readable warning per deprecated `META_SOCIAL_*` alias that is
   * set (D8); empty when none are. Logged once at startup by
   * MetaGraphModule. Kept here so the alias rules live next to the getters
   * that apply them.
   */
  get deprecatedMetaEnvWarnings(): string[] {
    return [
      deprecatedAliasWarning(
        'META_SOCIAL_APP_SECRET',
        'META_APP_SECRET',
        this.env.META_SOCIAL_APP_SECRET,
        this.env.META_APP_SECRET,
      ),
      deprecatedAliasWarning(
        'META_SOCIAL_VERIFY_TOKEN',
        'META_VERIFY_TOKEN',
        this.env.META_SOCIAL_VERIFY_TOKEN,
        this.env.META_VERIFY_TOKEN,
      ),
    ].filter((warning): warning is string => warning !== null);
  }

  // ---- Feature 16: Messenger + Instagram DM ----

  /** Whether MetaChannelModule binds real adapters. Additive to BSP_PROVIDER, never an alternative to it — see env.schema.ts. */
  get metaSocialChannelsEnabled(): boolean {
    return this.env.META_SOCIAL_CHANNELS_ENABLED;
  }

  /** Required when metaSocialChannelsEnabled — envSchema enforces it. Only the token-refresh path uses it. */
  get metaAppId(): string {
    return this.env.META_APP_ID ?? '';
  }

  get metaTokenRefreshIntervalMs(): number {
    return this.env.META_TOKEN_REFRESH_INTERVAL_MS;
  }

  /** Gulf T5 (D5): period of the WhatsApp number-health reconcile sweep. */
  get whatsappHealthReconcileIntervalMs(): number {
    return this.env.WHATSAPP_HEALTH_RECONCILE_INTERVAL_MS;
  }

  /** DEV-ONLY escape hatch; envSchema makes `false` a startup failure under NODE_ENV=production. See BSP_WEBHOOK_SIGNATURE_REQUIRED's comment in env.schema.ts. */
  get bspWebhookSignatureRequired(): boolean {
    return this.env.BSP_WEBHOOK_SIGNATURE_REQUIRED;
  }

  get bspRequestTimeoutMs(): number {
    return this.env.BSP_REQUEST_TIMEOUT_MS;
  }

  get whatsappConnectStateSecret(): string {
    return this.env.WHATSAPP_CONNECT_STATE_SECRET ?? '';
  }

  get apiPublicBaseUrl(): string {
    return this.env.API_PUBLIC_BASE_URL ?? '';
  }

  get kbStorageProvider(): Env['KB_STORAGE_PROVIDER'] {
    return this.env.KB_STORAGE_PROVIDER;
  }

  get kbLocalStorageDir(): string {
    return this.env.KB_LOCAL_STORAGE_DIR;
  }

  /** Only meaningful when kbStorageProvider === 'supabase'. */
  get kbStorageBucket(): string {
    return this.env.KB_STORAGE_BUCKET;
  }

  /** F13: largest inbound attachment stored. Anything over this is refused with `media_status = 'too_large'`. */
  get inboundMediaMaxBytes(): number {
    return this.env.INBOUND_MEDIA_MAX_BYTES;
  }

  get llmProvider(): Env['LLM_PROVIDER'] {
    return this.env.LLM_PROVIDER;
  }

  get llmBaseUrl(): string {
    return this.env.LLM_BASE_URL;
  }

  get llmModel(): string {
    return this.env.LLM_MODEL;
  }

  get llmRequestTimeoutMs(): number {
    return this.env.LLM_REQUEST_TIMEOUT_MS;
  }

  get llmBreakerFailureThreshold(): number {
    return this.env.LLM_BREAKER_FAILURE_THRESHOLD;
  }

  get llmBreakerResetMs(): number {
    return this.env.LLM_BREAKER_RESET_MS;
  }

  /** D9: Cloudflare Access service-token id fronting the self-hosted vLLM tunnel. Undefined outside production (or when a self-hosted host isn't selected) — see env.schema.ts's refine(). */
  get cfAccessClientId(): string | undefined {
    return this.env.CF_ACCESS_CLIENT_ID;
  }

  get cfAccessClientSecret(): string | undefined {
    return this.env.CF_ACCESS_CLIENT_SECRET;
  }

  /** Undefined disables Sentry entirely — instrument.ts's Sentry.init() call is skipped, not called with an empty DSN. */
  get sentryDsn(): string | undefined {
    return this.env.SENTRY_DSN;
  }

  get sentryEnvironment(): string {
    return this.env.SENTRY_ENVIRONMENT ?? this.env.NODE_ENV;
  }

  get sentryTracesSampleRate(): number {
    return this.env.SENTRY_TRACES_SAMPLE_RATE;
  }

  /** Where platform-health alerts (circuit breaker, DLQ depth, DB/Redis down) page a human — see PlatformHealthPagingSubscriber. */
  get platformAlertEmail(): string | undefined {
    return this.env.PLATFORM_ALERT_EMAIL;
  }

  get geminiApiKey(): string {
    return this.env.GEMINI_API_KEY;
  }

  get deepseekApiKey(): string {
    return this.env.DEEPSEEK_API_KEY;
  }

  get deepseekBaseUrl(): string {
    return this.env.DEEPSEEK_BASE_URL;
  }

  get deepseekModel(): string {
    return this.env.DEEPSEEK_MODEL;
  }

  /** A11: vendor backing the vision-capable LlmProvider binding. 'none' = images escalate as UNSUPPORTED_MEDIA, the pre-Feature-17 behaviour. */
  get visionProvider(): Env['VISION_PROVIDER'] {
    return this.env.VISION_PROVIDER;
  }

  get visionBaseUrl(): string {
    return this.env.VISION_BASE_URL;
  }

  get visionModel(): string {
    return this.env.VISION_MODEL;
  }

  /** A12: vendor backing the Transcriber port. 'none' = voice notes escalate as UNSUPPORTED_MEDIA. */
  get asrProvider(): Env['ASR_PROVIDER'] {
    return this.env.ASR_PROVIDER;
  }

  get asrBaseUrl(): string {
    return this.env.ASR_BASE_URL;
  }

  get asrModel(): string {
    return this.env.ASR_MODEL;
  }

  /** ASR_PROVIDER=openai-compatible: optional bearer token; '' sends no Authorization header. */
  get asrApiKey(): string {
    return this.env.ASR_API_KEY;
  }

  get huggingfaceApiKey(): string {
    return this.env.HUGGINGFACE_API_KEY;
  }

  get huggingfaceAsrModel(): string {
    return this.env.HUGGINGFACE_ASR_MODEL;
  }

  /** A11/A12: largest attachment handed to a multimodal model in one turn — not the same ceiling as `inboundMediaMaxBytes` (what we store). */
  get mediaUnderstandingMaxBytes(): number {
    return this.env.MEDIA_UNDERSTANDING_MAX_BYTES;
  }

  get embeddingProvider(): Env['EMBEDDING_PROVIDER'] {
    return this.env.EMBEDDING_PROVIDER;
  }

  get embeddingModel(): string {
    return this.env.EMBEDDING_MODEL;
  }

  get embeddingDimensions(): number {
    return this.env.EMBEDDING_DIMENSIONS;
  }

  /** Only meaningful when embeddingProvider === 'qwen' — validated as required in that case by envSchema's refine(). */
  get embeddingBaseUrl(): string {
    return this.env.EMBEDDING_BASE_URL ?? '';
  }

  /** Bearer token for a non-CF-Access-fronted embeddingBaseUrl — see env.schema.ts's EMBEDDING_API_KEY comment. */
  get embeddingApiKey(): string | undefined {
    return this.env.EMBEDDING_API_KEY;
  }

  get embeddingMaxInputTokens(): number {
    return this.env.EMBEDDING_MAX_INPUT_TOKENS;
  }

  get rerankProvider(): Env['RERANK_PROVIDER'] {
    return this.env.RERANK_PROVIDER;
  }

  /** Only meaningful when rerankProvider === 'cohere' — validated as required in that case by envSchema's refine(). */
  get cohereApiKey(): string {
    return this.env.COHERE_API_KEY ?? '';
  }

  /** Hard cap on one rerank call; past it the query falls back to the RRF-fused order (see RetrievalSearchService.rerankOrDegrade). */
  get rerankTimeoutMs(): number {
    return this.env.RERANK_TIMEOUT_MS;
  }

  get agentLoopDeadlineMs(): number {
    return this.env.AGENT_LOOP_DEADLINE_MS;
  }

  get agentGroundingCheckEnabled(): boolean {
    return this.env.AGENT_GROUNDING_CHECK_ENABLED;
  }

  get burstCoalesceDebounceMs(): number {
    return this.env.BURST_COALESCE_DEBOUNCE_MS;
  }

  get stuckTicketCheckIntervalMs(): number {
    return this.env.STUCK_TICKET_CHECK_INTERVAL_MS;
  }

  get latencyP95BudgetMs(): number {
    return this.env.LATENCY_P95_BUDGET_MS;
  }

  get latencyCheckWindowMinutes(): number {
    return this.env.LATENCY_CHECK_WINDOW_MINUTES;
  }

  get latencyCheckIntervalMs(): number {
    return this.env.LATENCY_CHECK_INTERVAL_MS;
  }

  /** F19 (D1/D8): the hard cap SegmentResolver.snapshot() enforces. */
  get campaignMaxRecipients(): number {
    return this.env.CAMPAIGN_MAX_RECIPIENTS;
  }

  /** F19 (D3): recipients per `campaign-send` batch job. */
  get campaignBatchSize(): number {
    return this.env.CAMPAIGN_BATCH_SIZE;
  }

  /** F19 (D3): per-number throughput ceiling, messages per second. */
  get campaignSendRatePerSecond(): number {
    return this.env.CAMPAIGN_SEND_RATE_PER_SECOND;
  }

  /** F19 (D3): percent of a number's 24h tier allowance a campaign may use. */
  get campaignTierHeadroomPct(): number {
    return this.env.CAMPAIGN_TIER_HEADROOM_PCT;
  }

  /** F19 (D3): how many 24h windows one campaign may span. */
  get campaignMaxWindowSpan(): number {
    return this.env.CAMPAIGN_MAX_WINDOW_SPAN;
  }

  /** F19 (D3): fallback spend cap when the tenant has no policy row. */
  get campaignDefaultSpendCapUsd(): number {
    return this.env.CAMPAIGN_DEFAULT_SPEND_CAP_USD;
  }

  /** F19 (D5): last-touch reply attribution window, in days. */
  get campaignReplyAttributionDays(): number {
    return this.env.CAMPAIGN_REPLY_ATTRIBUTION_DAYS;
  }

  /** F26 (D5): how often the shipment poll sweep wakes up. */
  get shipmentPollIntervalMs(): number {
    return this.env.SHIPMENT_POLL_INTERVAL_MS;
  }

  get autoCloseInactivityHours(): number {
    return this.env.AUTO_CLOSE_INACTIVITY_HOURS;
  }

  get autoCloseCheckIntervalMs(): number {
    return this.env.AUTO_CLOSE_CHECK_INTERVAL_MS;
  }

  get trialEmailCheckIntervalMs(): number {
    return this.env.TRIAL_EMAIL_CHECK_INTERVAL_MS;
  }

  get trialEndingSoonDays(): number {
    return this.env.TRIAL_ENDING_SOON_DAYS;
  }

  get transcriptRetentionDays(): number {
    return this.env.TRANSCRIPT_RETENTION_DAYS;
  }

  get purgeCheckIntervalMs(): number {
    return this.env.PURGE_CHECK_INTERVAL_MS;
  }

  get tenantPurgeGraceDays(): number {
    return this.env.TENANT_PURGE_GRACE_DAYS;
  }

  get dataExportTtlDays(): number {
    return this.env.DATA_EXPORT_TTL_DAYS;
  }

  get platformHealthCheckIntervalMs(): number {
    return this.env.PLATFORM_HEALTH_CHECK_INTERVAL_MS;
  }

  get queueDlqDepthThreshold(): number {
    return this.env.QUEUE_DLQ_DEPTH_THRESHOLD;
  }

  get tenantCountAlertThreshold(): number {
    return this.env.TENANT_COUNT_ALERT_THRESHOLD;
  }

  get toolScopeViolationAlertThreshold(): number {
    return this.env.TOOL_SCOPE_VIOLATION_ALERT_THRESHOLD;
  }

  get toolScopeViolationCheckWindowMinutes(): number {
    return this.env.TOOL_SCOPE_VIOLATION_CHECK_WINDOW_MINUTES;
  }

  get toolScopeViolationCheckIntervalMs(): number {
    return this.env.TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS;
  }

  get billingProvider(): Env['BILLING_PROVIDER'] {
    return this.env.BILLING_PROVIDER;
  }

  /** Only meaningful when billingProvider === 'stripe' — validated as required in that case by envSchema's refine(). */
  get stripeSecretKey(): string {
    return this.env.STRIPE_SECRET_KEY ?? '';
  }

  get stripeWebhookSecret(): string {
    return this.env.STRIPE_WEBHOOK_SECRET ?? '';
  }

  /** Local Stripe API double (stripe-mock) for tests; undefined means the real api.stripe.com. Rejected in production by envSchema. */
  get stripeApiBaseUrl(): string | undefined {
    return this.env.STRIPE_API_BASE_URL;
  }

  // ---- Feature 24: Store Integrations ----
  //
  // No deployment-wide provider setting: the provider is per-tenant
  // (`store_connections.provider`). See the Feature 24 block in env.schema.ts
  // for why there is no STORE_PROVIDER enum and where the fail-fast lives.

  /**
   * Whether this deployment can run a connect flow for `provider` at all.
   * StoreOAuthService calls this before minting an authorize URL so a
   * missing credential surfaces as a 503 the merchant/operator can act on,
   * rather than a redirect carrying `client_id=`.
   */
  isStoreProviderConfigured(provider: StoreProviderCredentialName): boolean {
    switch (provider) {
      case 'salla':
        return !!this.env.SALLA_CLIENT_ID && !!this.env.SALLA_CLIENT_SECRET;
      case 'zid':
        return !!this.env.ZID_CLIENT_ID && !!this.env.ZID_CLIENT_SECRET;
      case 'shopify':
        return !!this.env.SHOPIFY_CLIENT_ID && !!this.env.SHOPIFY_CLIENT_SECRET;
      case 'woocommerce':
        // WooCommerce has no platform-level OAuth app (see the env.schema
        // block) — the per-merchant credential is minted by the merchant's
        // own site. But that site has to POST the new key pair back to us,
        // so an ABSOLUTE callback URL is the one thing this deployment can
        // still be missing. `woocommerceCallbackUrl` falls back to
        // `${API_PUBLIC_BASE_URL}/store/callback/woocommerce`, which is a
        // bare relative path when that variable is unset; handing the
        // merchant's WordPress a relative `callback_url` means the key
        // delivery silently never arrives. A false here surfaces it as the
        // 503 StoreOAuthService already raises.
        return (
          !!this.env.WOOCOMMERCE_CALLBACK_URL || !!this.env.API_PUBLIC_BASE_URL
        );
    }
  }

  get sallaClientId(): string {
    return this.env.SALLA_CLIENT_ID ?? '';
  }

  get sallaClientSecret(): string {
    return this.env.SALLA_CLIENT_SECRET ?? '';
  }

  /** Defaults to the route StoreCallbackController actually serves, so a deployment only sets this when the provider console has a different value registered. */
  get sallaRedirectUri(): string {
    return (
      this.env.SALLA_REDIRECT_URI ??
      `${this.apiPublicBaseUrl}/store/callback/salla`
    );
  }

  get zidClientId(): string {
    return this.env.ZID_CLIENT_ID ?? '';
  }

  get zidClientSecret(): string {
    return this.env.ZID_CLIENT_SECRET ?? '';
  }

  /** See sallaRedirectUri. */
  get zidRedirectUri(): string {
    return (
      this.env.ZID_REDIRECT_URI ?? `${this.apiPublicBaseUrl}/store/callback/zid`
    );
  }

  /** Zid App ID, sent as the webhook `original_id`. Empty when unset. */
  get zidAppId(): string {
    return this.env.ZID_APP_ID ?? '';
  }

  get shopifyClientId(): string {
    return this.env.SHOPIFY_CLIENT_ID ?? '';
  }

  get shopifyClientSecret(): string {
    return this.env.SHOPIFY_CLIENT_SECRET ?? '';
  }

  get shopifyShopDomain(): string {
    return this.env.SHOPIFY_SHOP_DOMAIN ?? '';
  }

  get woocommerceAppName(): string {
    return this.env.WOOCOMMERCE_APP_NAME;
  }

  /** See sallaRedirectUri. This is the URL the merchant's own site POSTs the new key pair to. */
  get woocommerceCallbackUrl(): string {
    return (
      this.env.WOOCOMMERCE_CALLBACK_URL ??
      `${this.apiPublicBaseUrl}/store/callback/woocommerce`
    );
  }

  get storeSyncIntervalMs(): number {
    return this.env.STORE_SYNC_INTERVAL_MS;
  }

  // ---- Feature 7: Tenant Provisioning ----

  get tenantProvisioningProvider(): Env['TENANT_PROVISIONING_PROVIDER'] {
    return this.env.TENANT_PROVISIONING_PROVIDER;
  }

  /** Only meaningful when tenantProvisioningProvider === 'supabase' — validated as required in that case by envSchema's refine(). */
  get supabaseUrl(): string {
    return this.env.SUPABASE_URL ?? '';
  }

  get supabaseServiceRoleKey(): string {
    return this.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  }

  get emailProvider(): Env['EMAIL_PROVIDER'] {
    return this.env.EMAIL_PROVIDER;
  }

  /** Only meaningful when emailProvider === 'resend' — validated as required in that case by envSchema's refine(). */
  get resendApiKey(): string {
    return this.env.RESEND_API_KEY ?? '';
  }

  get emailFromAddress(): string {
    return this.env.EMAIL_FROM_ADDRESS ?? '';
  }

  /** Empty when unset: an alert email drops its deep link rather than linking somewhere wrong. */
  get consoleBaseUrl(): string {
    return this.env.CONSOLE_BASE_URL ?? '';
  }

  /** Clarly 2.0 S3. Express `trust proxy` hop count. */
  get trustProxyHops(): number {
    return this.env.TRUST_PROXY_HOPS;
  }

  /** Clarly 2.0 S2. Empty when Google Calendar connect is not configured. */
  get googleCalendarClientId(): string {
    return this.env.GOOGLE_CALENDAR_CLIENT_ID ?? '';
  }

  get googleCalendarClientSecret(): string {
    return this.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? '';
  }

  get googleCalendarRedirectUri(): string {
    return (
      this.env.GOOGLE_CALENDAR_REDIRECT_URI ??
      `${this.apiPublicBaseUrl}/bookings/calendar/callback`
    );
  }
}

/**
 * Never includes either value — these are secrets. Says which one wins when
 * both are set, because a deployment that relied on two DIFFERENT values
 * (two Meta apps) now has its social webhooks verified against the primary.
 */
function deprecatedAliasWarning(
  alias: string,
  primary: string,
  aliasValue: string | undefined,
  primaryValue: string | undefined,
): string | null {
  if (aliasValue === undefined) return null;
  if (primaryValue === undefined) {
    return `${alias} is deprecated and will be removed next release — rename it to ${primary}, which now covers WhatsApp, Messenger and Instagram alike.`;
  }
  const conflict =
    aliasValue === primaryValue
      ? ''
      : ` The two values DIFFER: the social channels now use ${primary}, so anything still signed or verified with the old ${alias} value will be rejected.`;
  return `${alias} is deprecated and ignored because ${primary} is set — remove it.${conflict}`;
}
