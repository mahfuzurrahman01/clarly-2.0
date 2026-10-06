import { AppConfigService } from './app-config.service';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_JWT_SECRET: 'a-secret',
  BSP_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  GEMINI_API_KEY: 'a-gemini-key',
  DEEPSEEK_API_KEY: 'a-deepseek-key',
  // EMBEDDING_PROVIDER defaults to 'qwen', which requires a base URL.
  EMBEDDING_BASE_URL: 'https://embed.example.com',
  // LLM_PROVIDER defaults to 'deepseek'; LLM_BASE_URL/LLM_MODEL default to
  // DeepSeek's values.
  LLM_BASE_URL: 'https://api.deepseek.com/v1',
  LLM_MODEL: 'deepseek-v4-flash',
};

describe('AppConfigService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...BASE_ENV };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('exposes every parsed var through its getters', () => {
    const config = new AppConfigService();

    expect(config.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
    expect(config.redisUrl).toBe(BASE_ENV.REDIS_URL);
    expect(config.supabaseJwtSecret).toBe(BASE_ENV.SUPABASE_JWT_SECRET);
    expect(config.bspCredentialsEncryptionKey).toBe(
      BASE_ENV.BSP_CREDENTIALS_ENCRYPTION_KEY,
    );
    expect(config.port).toBe(4000);
    expect(config.nodeEnv).toBe('development');
    expect(config.kbLocalStorageDir).toBe('.data/kb-uploads');
    expect(config.llmProvider).toBe('deepseek');
    expect(config.llmBaseUrl).toBe(BASE_ENV.LLM_BASE_URL);
    expect(config.llmModel).toBe(BASE_ENV.LLM_MODEL);
    expect(config.llmRequestTimeoutMs).toBe(10000);
    expect(config.llmBreakerFailureThreshold).toBe(5);
    expect(config.llmBreakerResetMs).toBe(30000);
    expect(config.geminiApiKey).toBe(BASE_ENV.GEMINI_API_KEY);
    expect(config.embeddingProvider).toBe('qwen');
    expect(config.embeddingModel).toBe('qwen3-embedding-0.6b');
    expect(config.embeddingDimensions).toBe(1024);
    expect(config.embeddingBaseUrl).toBe(BASE_ENV.EMBEDDING_BASE_URL);
    expect(config.embeddingMaxInputTokens).toBe(4096);
  });

  describe('queueProfile', () => {
    it("defaults to 'default'", () => {
      expect(new AppConfigService().queueProfile).toBe('default');
    });

    it("exposes 'lean' and the lean sweep cadence when QUEUE_PROFILE=lean", () => {
      process.env.QUEUE_PROFILE = 'lean';

      const config = new AppConfigService();

      expect(config.queueProfile).toBe('lean');
      expect(config.platformHealthCheckIntervalMs).toBe(300_000);
    });

    it('fails fast at construction on an unknown profile', () => {
      process.env.QUEUE_PROFILE = 'cheap';

      expect(() => new AppConfigService()).toThrow(/QUEUE_PROFILE/);
    });
  });

  describe('corsOrigins', () => {
    it('defaults to the local Next.js dev server', () => {
      expect(new AppConfigService().corsOrigins).toEqual([
        'http://localhost:3000',
      ]);
    });

    it('splits a comma-separated list and trims surrounding whitespace', () => {
      process.env.CORS_ORIGINS =
        'https://console.example.com, https://staging.example.com';

      expect(new AppConfigService().corsOrigins).toEqual([
        'https://console.example.com',
        'https://staging.example.com',
      ]);
    });

    it('is empty when unset to an empty string, disabling CORS entirely', () => {
      process.env.CORS_ORIGINS = '';

      expect(new AppConfigService().corsOrigins).toEqual([]);
    });
  });

  // Phase 6 review findings 3+4: WooCommerce used to hard-return true here,
  // so StoreOAuthService's 503 guard could never fire — and the merchant's
  // WordPress was handed a bare relative `callback_url` built from an unset
  // API_PUBLIC_BASE_URL, so the key delivery silently never arrived.
  describe('isStoreProviderConfigured("woocommerce")', () => {
    it('is false when neither the callback URL nor the public base URL is set', () => {
      expect(
        new AppConfigService().isStoreProviderConfigured('woocommerce'),
      ).toBe(false);
    });

    it('is true from API_PUBLIC_BASE_URL, which is what the default callback is built from', () => {
      process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';

      const config = new AppConfigService();
      expect(config.isStoreProviderConfigured('woocommerce')).toBe(true);
      expect(config.woocommerceCallbackUrl).toBe(
        'https://api.example.com/store/callback/woocommerce',
      );
    });

    it('is true from an explicit WOOCOMMERCE_CALLBACK_URL alone', () => {
      process.env.WOOCOMMERCE_CALLBACK_URL =
        'https://hooks.example.com/woo/callback';

      expect(
        new AppConfigService().isStoreProviderConfigured('woocommerce'),
      ).toBe(true);
    });
  });

  describe('WhatsApp connect getters', () => {
    it('default to empty strings when unset', () => {
      const config = new AppConfigService();
      expect(config.whatsappConnectStateSecret).toBe('');
      expect(config.apiPublicBaseUrl).toBe('');
    });

    it('expose the configured values when set', () => {
      process.env.WHATSAPP_CONNECT_STATE_SECRET = 'state-secret';
      process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';

      const config = new AppConfigService();
      expect(config.whatsappConnectStateSecret).toBe('state-secret');
      expect(config.apiPublicBaseUrl).toBe('https://api.example.com');
    });
  });

  it('isProduction is true only when NODE_ENV=production', () => {
    // D4: NODE_ENV=production also requires every provider below to be
    // configured (env.schema.ts's refine chain) — set here purely so this
    // test can exercise isProduction without tripping that unrelated guard
    // (covered on its own in env.schema.spec.ts's "production provider
    // refine (D4)" suite).
    process.env.NODE_ENV = 'production';
    process.env.BSP_PROVIDER = 'meta';
    process.env.META_VERIFY_TOKEN = 'a-verify-token';
    process.env.META_APP_SECRET = 'an-app-secret';
    process.env.META_APP_ID = 'an-app-id';
    process.env.WHATSAPP_CONNECT_STATE_SECRET = 'a-connect-state-secret';
    process.env.API_PUBLIC_BASE_URL = 'https://api.example.com';
    process.env.BILLING_PROVIDER = 'stripe';
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 'a-resend-key';
    process.env.EMAIL_FROM_ADDRESS = 'alerts@example.com';
    process.env.TENANT_PROVISIONING_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-service-role-key';
    // D9: LLM_PROVIDER/EMBEDDING_PROVIDER default to 'qwen' (self-hosted),
    // which the tunnel-auth refine also requires in production.
    process.env.LLM_PROVIDER = 'qwen';
    process.env.LLM_BASE_URL = 'https://llm.example.com/v1';
    process.env.LLM_MODEL = 'qwen3.6-35b-a3b';
    process.env.CF_ACCESS_CLIENT_ID = 'a-client-id';
    process.env.CF_ACCESS_CLIENT_SECRET = 'a-client-secret';
    expect(new AppConfigService().isProduction).toBe(true);

    process.env.NODE_ENV = 'development';
    expect(new AppConfigService().isProduction).toBe(false);
  });

  it('fails fast at construction when a required var is missing', () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => new AppConfigService()).toThrow(
      /SUPABASE_JWT_SECRET: Required/,
    );
  });

  describe('Sentry (observability)', () => {
    it('is undefined by default — instrument.ts must skip Sentry.init() entirely, not call it with an empty DSN', () => {
      expect(new AppConfigService().sentryDsn).toBeUndefined();
    });

    it('exposes the configured DSN', () => {
      process.env.SENTRY_DSN = 'https://key@o0.ingest.sentry.io/0';
      expect(new AppConfigService().sentryDsn).toBe(process.env.SENTRY_DSN);
    });

    it('sentryEnvironment falls back to NODE_ENV when SENTRY_ENVIRONMENT is unset', () => {
      process.env.NODE_ENV = 'development';
      expect(new AppConfigService().sentryEnvironment).toBe('development');
    });

    it('sentryEnvironment prefers the explicit override', () => {
      process.env.SENTRY_ENVIRONMENT = 'staging';
      expect(new AppConfigService().sentryEnvironment).toBe('staging');
    });

    it('defaults the traces sample rate to 0.1', () => {
      expect(new AppConfigService().sentryTracesSampleRate).toBe(0.1);
    });
  });

  describe('platformAlertEmail', () => {
    it('is undefined by default', () => {
      expect(new AppConfigService().platformAlertEmail).toBeUndefined();
    });

    it('exposes the configured address', () => {
      process.env.PLATFORM_ALERT_EMAIL = 'ops@example.com';
      expect(new AppConfigService().platformAlertEmail).toBe('ops@example.com');
    });
  });

  describe('Meta app secret / verify token (D8)', () => {
    it('default to empty strings with no deprecation warnings', () => {
      const config = new AppConfigService();
      expect(config.metaAppSecret).toBe('');
      expect(config.metaVerifyToken).toBe('');
      expect(config.deprecatedMetaEnvWarnings).toEqual([]);
    });

    it('use META_APP_SECRET / META_VERIFY_TOKEN when set', () => {
      process.env.META_APP_SECRET = 'primary-secret';
      process.env.META_VERIFY_TOKEN = 'primary-token';
      const config = new AppConfigService();
      expect(config.metaAppSecret).toBe('primary-secret');
      expect(config.metaVerifyToken).toBe('primary-token');
      expect(config.deprecatedMetaEnvWarnings).toEqual([]);
    });

    it('fall back to the deprecated META_SOCIAL_* aliases and warn to rename them', () => {
      process.env.META_SOCIAL_APP_SECRET = 'alias-secret';
      process.env.META_SOCIAL_VERIFY_TOKEN = 'alias-token';
      const config = new AppConfigService();

      expect(config.metaAppSecret).toBe('alias-secret');
      expect(config.metaVerifyToken).toBe('alias-token');
      expect(config.deprecatedMetaEnvWarnings).toEqual([
        expect.stringMatching(
          /META_SOCIAL_APP_SECRET is deprecated.*rename it to META_APP_SECRET/,
        ),
        expect.stringMatching(
          /META_SOCIAL_VERIFY_TOKEN is deprecated.*rename it to META_VERIFY_TOKEN/,
        ),
      ]);
    });

    it('prefer the primary when both are set, flag a conflict, and never log a value', () => {
      process.env.META_APP_SECRET = 'primary-secret';
      process.env.META_SOCIAL_APP_SECRET = 'alias-secret';
      process.env.META_VERIFY_TOKEN = 'same-token';
      process.env.META_SOCIAL_VERIFY_TOKEN = 'same-token';
      const config = new AppConfigService();

      expect(config.metaAppSecret).toBe('primary-secret');
      expect(config.metaVerifyToken).toBe('same-token');
      const [secretWarning, tokenWarning] = config.deprecatedMetaEnvWarnings;
      expect(secretWarning).toMatch(/ignored because META_APP_SECRET is set/);
      expect(secretWarning).toMatch(/DIFFER/);
      expect(tokenWarning).toMatch(/ignored because META_VERIFY_TOKEN is set/);
      expect(tokenWarning).not.toMatch(/DIFFER/);
      for (const warning of config.deprecatedMetaEnvWarnings) {
        expect(warning).not.toMatch(/primary-secret|alias-secret|same-token/);
      }
    });
  });
});
