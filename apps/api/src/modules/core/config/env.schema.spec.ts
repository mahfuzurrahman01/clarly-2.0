import { parseEnv } from './env.schema';

const VALID_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_JWT_SECRET: 'a-secret',
  BSP_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  GEMINI_API_KEY: 'a-gemini-key',
  DEEPSEEK_API_KEY: 'a-deepseek-key',
  // EMBEDDING_PROVIDER defaults to 'qwen', which requires a base URL — the
  // vLLM endpoint has no credential to stand in for one.
  EMBEDDING_BASE_URL: 'https://embed.example.com',
  // LLM_PROVIDER defaults to 'deepseek'; LLM_BASE_URL/LLM_MODEL default to
  // DeepSeek's values.
  LLM_BASE_URL: 'https://api.deepseek.com/v1',
  LLM_MODEL: 'deepseek-v4-flash',
};

describe('parseEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseEnv(VALID_ENV);

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
  });

  it('coerces PORT from a string', () => {
    const env = parseEnv({ ...VALID_ENV, PORT: '5000' });
    expect(env.PORT).toBe(5000);
  });

  it('throws a readable, aggregated error when required vars are missing', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL: Required/);
  });

  it('rejects an invalid NODE_ENV value', () => {
    expect(() => parseEnv({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow();
  });

  it('lists every missing var in one error, not just the first', () => {
    expect(() => parseEnv({})).toThrow(/REDIS_URL: Required/);
  });

  it('rejects a BSP_CREDENTIALS_ENCRYPTION_KEY that does not decode to 32 bytes', () => {
    expect(() =>
      parseEnv({ ...VALID_ENV, BSP_CREDENTIALS_ENCRYPTION_KEY: 'too-short' }),
    ).toThrow(/must decode \(base64\) to exactly 32 bytes/);
  });

  it('accepts a valid 32-byte base64 BSP_CREDENTIALS_ENCRYPTION_KEY', () => {
    const env = parseEnv(VALID_ENV);
    expect(
      Buffer.from(env.BSP_CREDENTIALS_ENCRYPTION_KEY, 'base64'),
    ).toHaveLength(32);
  });

  describe('BSP webhook signature guard', () => {
    it('defaults to requiring signature verification', () => {
      expect(parseEnv(VALID_ENV).BSP_WEBHOOK_SIGNATURE_REQUIRED).toBe(true);
    });

    it("parses the STRING 'false' as false (z.coerce.boolean would wrongly make it true)", () => {
      const env = parseEnv({
        ...VALID_ENV,
        BSP_WEBHOOK_SIGNATURE_REQUIRED: 'false',
      });
      expect(env.BSP_WEBHOOK_SIGNATURE_REQUIRED).toBe(false);
    });

    it('rejects a non-boolean string rather than silently defaulting', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, BSP_WEBHOOK_SIGNATURE_REQUIRED: 'no' }),
      ).toThrow();
    });

    it('FAILS STARTUP when the Stripe API base URL is set in production', () => {
      // Left set by accident, every live payment call would go somewhere
      // that is not Stripe — over plaintext HTTP, carrying a live secret
      // key. Refused at boot rather than trusted to code review.
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          NODE_ENV: 'production',
          STRIPE_API_BASE_URL: 'http://127.0.0.1:12111',
        }),
      ).toThrow(/must never be set in production/);
    });

    it('allows the Stripe API base URL outside production (stripe-mock)', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          NODE_ENV: 'test',
          STRIPE_API_BASE_URL: 'http://127.0.0.1:12111',
        }),
      ).not.toThrow();
    });

    it('FAILS STARTUP when verification is disabled in production', () => {
      // The structural guard: an unauthenticated /webhooks/whatsapp must be
      // impossible to deploy, not merely discouraged.
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          NODE_ENV: 'production',
          BSP_WEBHOOK_SIGNATURE_REQUIRED: 'false',
        }),
      ).toThrow(/must never be used with NODE_ENV=production/);
    });

    it('allows it outside production', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          NODE_ENV: 'development',
          BSP_WEBHOOK_SIGNATURE_REQUIRED: 'false',
        }),
      ).not.toThrow();
    });

    it("rejects the removed '360dialog' provider (D14)", () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, BSP_PROVIDER: '360dialog' }),
      ).toThrow(/BSP_PROVIDER/);
    });
  });

  describe('WhatsApp connect vars (D14: provider-agnostic)', () => {
    it('does not require WHATSAPP_CONNECT_STATE_SECRET or API_PUBLIC_BASE_URL for BSP_PROVIDER=none (default)', () => {
      expect(() => parseEnv(VALID_ENV)).not.toThrow();
    });

    it('does not require them for BSP_PROVIDER=meta', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'verify-token',
          META_APP_SECRET: 'app-secret',
          META_APP_ID: 'app-id',
        }),
      ).not.toThrow();
    });
  });

  describe('Meta Cloud API provider', () => {
    it('defaults the Graph host and version', () => {
      const env = parseEnv(VALID_ENV);
      expect(env.META_GRAPH_BASE_URL).toBe('https://graph.facebook.com');
      expect(env.META_GRAPH_VERSION).toBe('v21.0');
    });

    it('requires META_VERIFY_TOKEN when BSP_PROVIDER=meta (Meta will not register the webhook without it)', () => {
      expect(() => parseEnv({ ...VALID_ENV, BSP_PROVIDER: 'meta' })).toThrow(
        /META_VERIFY_TOKEN is required/,
      );
    });

    it('requires META_APP_SECRET when BSP_PROVIDER=meta', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'tok',
        }),
      ).toThrow(/META_APP_SECRET is required/);
    });

    it('accepts a fully configured meta provider', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'tok',
          META_APP_SECRET: 'secret',
          META_APP_ID: 'app-id',
        }),
      ).not.toThrow();
    });

    it('requires META_APP_ID when BSP_PROVIDER=meta (Gulf T3: Embedded Signup code exchange)', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'tok',
          META_APP_SECRET: 'secret',
        }),
      ).toThrow(/META_APP_ID is required when BSP_PROVIDER=meta/);
    });

    it('no longer waives META_APP_SECRET via the dev-only signature bypass (Gulf T3: the code exchange needs it)', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'tok',
          META_APP_ID: 'app-id',
          BSP_WEBHOOK_SIGNATURE_REQUIRED: 'false',
        }),
      ).toThrow(/META_APP_SECRET is required/);
    });

    it('still refuses that bypass in production', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          NODE_ENV: 'production',
          BSP_PROVIDER: 'meta',
          META_VERIFY_TOKEN: 'tok',
          BSP_WEBHOOK_SIGNATURE_REQUIRED: 'false',
        }),
      ).toThrow(/must never be used with NODE_ENV=production/);
    });

    it('rejects an unknown BSP_PROVIDER value', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, BSP_PROVIDER: 'twilio' }),
      ).toThrow();
    });
  });

  // D8 (Gulf T1): one META_APP_SECRET / META_VERIFY_TOKEN pair for all Meta
  // traffic; the META_SOCIAL_* names are deprecated aliases for one release
  // and satisfy the same requirements.
  describe('single Meta secret pair with deprecated META_SOCIAL_* aliases (D8)', () => {
    const SOCIAL = {
      ...VALID_ENV,
      META_SOCIAL_CHANNELS_ENABLED: 'true',
      META_APP_ID: 'app-id',
    };

    it('accepts social channels configured with the primary pair only', () => {
      expect(() =>
        parseEnv({
          ...SOCIAL,
          META_APP_SECRET: 'secret',
          META_VERIFY_TOKEN: 'tok',
        }),
      ).not.toThrow();
    });

    it('still accepts social channels configured with the deprecated aliases only', () => {
      expect(() =>
        parseEnv({
          ...SOCIAL,
          META_SOCIAL_APP_SECRET: 'secret',
          META_SOCIAL_VERIFY_TOKEN: 'tok',
        }),
      ).not.toThrow();
    });

    it('requires META_APP_SECRET for social channels when neither name is set', () => {
      expect(() => parseEnv({ ...SOCIAL, META_VERIFY_TOKEN: 'tok' })).toThrow(
        /META_APP_SECRET: META_APP_SECRET is required/,
      );
    });

    it('requires META_VERIFY_TOKEN for social channels when neither name is set', () => {
      expect(() => parseEnv({ ...SOCIAL, META_APP_SECRET: 'secret' })).toThrow(
        /META_VERIFY_TOKEN: META_VERIFY_TOKEN is required/,
      );
    });

    it('lets the aliases satisfy BSP_PROVIDER=meta too', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          BSP_PROVIDER: 'meta',
          META_SOCIAL_APP_SECRET: 'secret',
          META_SOCIAL_VERIFY_TOKEN: 'tok',
          META_APP_ID: 'app-id',
        }),
      ).not.toThrow();
    });
  });

  describe('llm provider', () => {
    it('defaults to the deepseek chat provider', () => {
      expect(parseEnv(VALID_ENV).LLM_PROVIDER).toBe('deepseek');
    });

    it('rejects a Gemini base URL under LLM_PROVIDER=qwen', () => {
      const env: Record<string, string> = { ...VALID_ENV };
      delete env.LLM_BASE_URL;
      env.LLM_PROVIDER = 'qwen';

      expect(() => parseEnv(env)).toThrow(
        /must point at the correct host and model/,
      );
    });

    it('rejects a DeepSeek model id under LLM_PROVIDER=qwen', () => {
      expect(() =>
        parseEnv({
          ...VALID_ENV,
          LLM_PROVIDER: 'qwen',
          LLM_MODEL: 'deepseek-v4-flash',
        }),
      ).toThrow(/must point at the correct host and model/);
    });

    it('leaves the gemini rollback path on its own defaults', () => {
      const env: Record<string, string> = { ...VALID_ENV };

      const parsed = parseEnv({
        ...env,
        LLM_PROVIDER: 'gemini',
        LLM_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
        LLM_MODEL: 'gemini-3.5-flash-lite',
      });

      expect(parsed.LLM_BASE_URL).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai',
      );
      expect(parsed.LLM_MODEL).toBe('gemini-3.5-flash-lite');
    });

    it('rejects an unknown LLM_PROVIDER value', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, LLM_PROVIDER: 'openai' }),
      ).toThrow();
    });
  });

  describe('embedder', () => {
    /** VALID_ENV minus the base URL, which most embedder cases vary. */
    const withoutBaseUrl = (): Record<string, string> => {
      const env: Record<string, string> = { ...VALID_ENV };
      delete env.EMBEDDING_BASE_URL;
      return env;
    };

    it('defaults to the self-hosted qwen provider at 1024 dimensions', () => {
      const env = parseEnv(VALID_ENV);

      expect(env.EMBEDDING_PROVIDER).toBe('qwen');
      // Pinned concrete id, not the floating `qwen-embed` alias — see the
      // schema comment; the alias served two different vector widths.
      expect(env.EMBEDDING_MODEL).toBe('qwen3-embedding-0.6b');
      expect(env.EMBEDDING_DIMENSIONS).toBe(1024);
      expect(env.EMBEDDING_MAX_INPUT_TOKENS).toBe(4096);
    });

    it('requires EMBEDDING_BASE_URL when the provider is qwen', () => {
      expect(() => parseEnv(withoutBaseUrl())).toThrow(
        /EMBEDDING_BASE_URL is required when EMBEDDING_PROVIDER=qwen/,
      );
    });

    it('does not require EMBEDDING_BASE_URL for the gemini rollback path', () => {
      expect(() =>
        parseEnv({ ...withoutBaseUrl(), EMBEDDING_PROVIDER: 'gemini' }),
      ).not.toThrow();
    });

    // kb_chunks.embedding is vector(1024) (migration 0023). A mismatch is
    // not a soft misconfiguration: every insert fails on a Postgres
    // dimension error, so this has to fail at boot rather than at first
    // ingest — which is exactly what caught the endpoint silently swapping
    // its served model from a 2560-wide one to a 1024-wide one.
    it('rejects any EMBEDDING_DIMENSIONS other than 1024', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, EMBEDDING_DIMENSIONS: '2560' }),
      ).toThrow(/must be 1024 to match kb_chunks.embedding vector\(1024\)/);
    });
  });

  // D4/Launch Plan item 4: 'none' is a real, supported adapter in dev/CI but
  // must be impossible to ship to production for any of these four
  // providers — a fully-configured non-'none' value for each is included so
  // production env's for the OTHER three providers don't also trip.
  describe('production provider refine (D4)', () => {
    const FULLY_CONFIGURED_PROD_ENV = {
      ...VALID_ENV,
      NODE_ENV: 'production',
      BSP_PROVIDER: 'meta',
      META_VERIFY_TOKEN: 'a-verify-token',
      META_APP_SECRET: 'an-app-secret',
      META_APP_ID: 'an-app-id',
      WHATSAPP_CONNECT_STATE_SECRET: 'a-connect-state-secret',
      API_PUBLIC_BASE_URL: 'https://api.example.com',
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'a-resend-key',
      EMAIL_FROM_ADDRESS: 'alerts@example.com',
      TENANT_PROVISIONING_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key',
      // D9: VALID_ENV's LLM_PROVIDER/EMBEDDING_PROVIDER default to 'qwen'
      // (self-hosted), which the tunnel-auth refine (below) also requires
      // in production.
      CF_ACCESS_CLIENT_ID: 'a-client-id',
      CF_ACCESS_CLIENT_SECRET: 'a-client-secret',
    };

    it('accepts a fully-configured production environment', () => {
      expect(() => parseEnv(FULLY_CONFIGURED_PROD_ENV)).not.toThrow();
    });

    it('FAILS STARTUP when BSP_PROVIDER=none in production', () => {
      expect(() =>
        parseEnv({ ...FULLY_CONFIGURED_PROD_ENV, BSP_PROVIDER: 'none' }),
      ).toThrow(/BSP_PROVIDER must not be "none" when NODE_ENV=production/);
    });

    it('FAILS STARTUP when BILLING_PROVIDER=none in production', () => {
      expect(() =>
        parseEnv({ ...FULLY_CONFIGURED_PROD_ENV, BILLING_PROVIDER: 'none' }),
      ).toThrow(/BILLING_PROVIDER must not be "none" when NODE_ENV=production/);
    });

    it('FAILS STARTUP when EMAIL_PROVIDER=none in production', () => {
      expect(() =>
        parseEnv({ ...FULLY_CONFIGURED_PROD_ENV, EMAIL_PROVIDER: 'none' }),
      ).toThrow(/EMAIL_PROVIDER must not be "none" when NODE_ENV=production/);
    });

    it('FAILS STARTUP when TENANT_PROVISIONING_PROVIDER=none in production', () => {
      expect(() =>
        parseEnv({
          ...FULLY_CONFIGURED_PROD_ENV,
          TENANT_PROVISIONING_PROVIDER: 'none',
        }),
      ).toThrow(
        /TENANT_PROVISIONING_PROVIDER must not be "none" when NODE_ENV=production/,
      );
    });

    it('allows every provider to be "none" outside production (dev/CI default)', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() => parseEnv({ ...VALID_ENV, NODE_ENV: 'test' })).not.toThrow();
    });

    // D9: the self-hosted AI host sits behind Cloudflare Access in
    // production. VALID_ENV already runs LLM_PROVIDER=qwen and
    // EMBEDDING_PROVIDER=qwen (their defaults), so this reuses
    // FULLY_CONFIGURED_PROD_ENV and only adds/removes the CF_ACCESS_* pair.
    describe('Cloudflare Access service token (D9)', () => {
      const PROD_WITH_TUNNEL_AUTH = {
        ...FULLY_CONFIGURED_PROD_ENV,
        CF_ACCESS_CLIENT_ID: 'a-client-id',
        CF_ACCESS_CLIENT_SECRET: 'a-client-secret',
      };

      it('accepts production with both service-token values set (self-hosted qwen is the default provider)', () => {
        expect(() => parseEnv(PROD_WITH_TUNNEL_AUTH)).not.toThrow();
      });

      it('FAILS STARTUP when CF_ACCESS_CLIENT_ID is missing in production with LLM_PROVIDER=qwen', () => {
        const env: Record<string, string> = { ...PROD_WITH_TUNNEL_AUTH };
        delete env.CF_ACCESS_CLIENT_ID;
        expect(() => parseEnv(env)).toThrow(
          /CF_ACCESS_CLIENT_ID is required when NODE_ENV=production/,
        );
      });

      it('FAILS STARTUP when CF_ACCESS_CLIENT_SECRET is missing in production with EMBEDDING_PROVIDER=qwen', () => {
        const env: Record<string, string> = { ...PROD_WITH_TUNNEL_AUTH };
        delete env.CF_ACCESS_CLIENT_SECRET;
        expect(() => parseEnv(env)).toThrow(
          /CF_ACCESS_CLIENT_SECRET is required when NODE_ENV=production/,
        );
      });

      it('does not require the service token in production when both providers are gemini (no tunnel involved)', () => {
        expect(() =>
          parseEnv({
            ...FULLY_CONFIGURED_PROD_ENV,
            LLM_PROVIDER: 'gemini',
            LLM_BASE_URL:
              'https://generativelanguage.googleapis.com/v1beta/openai',
            LLM_MODEL: 'gemini-3.5-flash-lite',
            EMBEDDING_PROVIDER: 'gemini',
          }),
        ).not.toThrow();
      });

      it('does not require the service token outside production', () => {
        expect(() =>
          parseEnv({ ...VALID_ENV, NODE_ENV: 'development' }),
        ).not.toThrow();
      });
    });
  });

  describe('Sentry (observability)', () => {
    it('is unset by default — a real no-op, not a placeholder DSN', () => {
      expect(parseEnv(VALID_ENV).SENTRY_DSN).toBeUndefined();
    });

    it('accepts a valid DSN', () => {
      const env = parseEnv({
        ...VALID_ENV,
        SENTRY_DSN: 'https://key@o0.ingest.sentry.io/0',
      });
      expect(env.SENTRY_DSN).toBe('https://key@o0.ingest.sentry.io/0');
    });

    it('rejects a non-URL DSN rather than silently disabling Sentry', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, SENTRY_DSN: 'not-a-url' }),
      ).toThrow();
    });

    it('defaults SENTRY_TRACES_SAMPLE_RATE to 0.1', () => {
      expect(parseEnv(VALID_ENV).SENTRY_TRACES_SAMPLE_RATE).toBe(0.1);
    });

    it('rejects a sample rate outside 0..1', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, SENTRY_TRACES_SAMPLE_RATE: '1.5' }),
      ).toThrow();
    });
  });

  describe('QUEUE_PROFILE', () => {
    it("defaults to 'default' and leaves every sweep interval at its normal default", () => {
      const env = parseEnv(VALID_ENV);

      expect(env.QUEUE_PROFILE).toBe('default');
      expect(env.STUCK_TICKET_CHECK_INTERVAL_MS).toBe(60_000);
      expect(env.LATENCY_CHECK_INTERVAL_MS).toBe(60_000);
      expect(env.PLATFORM_HEALTH_CHECK_INTERVAL_MS).toBe(60_000);
      expect(env.TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS).toBe(60_000);
      expect(env.AUTO_CLOSE_CHECK_INTERVAL_MS).toBe(300_000);
      expect(env.SHIPMENT_POLL_INTERVAL_MS).toBe(600_000);
      expect(env.STORE_SYNC_INTERVAL_MS).toBe(900_000);
    });

    it("accepts 'lean'", () => {
      expect(
        parseEnv({ ...VALID_ENV, QUEUE_PROFILE: 'lean' }).QUEUE_PROFILE,
      ).toBe('lean');
    });

    it.each(['Lean', 'free', ''])(
      'fails fast with a readable error on an unknown profile (%p)',
      (value) => {
        expect(() => parseEnv({ ...VALID_ENV, QUEUE_PROFILE: value })).toThrow(
          /QUEUE_PROFILE/,
        );
      },
    );

    it('lean raises the sub-hourly sweep intervals when they are not set explicitly', () => {
      const env = parseEnv({ ...VALID_ENV, QUEUE_PROFILE: 'lean' });

      expect(env.STUCK_TICKET_CHECK_INTERVAL_MS).toBe(300_000);
      expect(env.LATENCY_CHECK_INTERVAL_MS).toBe(300_000);
      expect(env.PLATFORM_HEALTH_CHECK_INTERVAL_MS).toBe(300_000);
      expect(env.TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS).toBe(300_000);
      expect(env.AUTO_CLOSE_CHECK_INTERVAL_MS).toBe(1_800_000);
      expect(env.SHIPMENT_POLL_INTERVAL_MS).toBe(1_800_000);
      expect(env.STORE_SYNC_INTERVAL_MS).toBe(3_600_000);
    });

    it('lean never stretches the tool-scope sweep past its detection window (no blind spots between checks)', () => {
      const env = parseEnv({ ...VALID_ENV, QUEUE_PROFILE: 'lean' });

      expect(env.TOOL_SCOPE_VIOLATION_CHECK_INTERVAL_MS).toBeLessThanOrEqual(
        env.TOOL_SCOPE_VIOLATION_CHECK_WINDOW_MINUTES * 60_000,
      );
      expect(env.LATENCY_CHECK_INTERVAL_MS).toBeLessThanOrEqual(
        env.LATENCY_CHECK_WINDOW_MINUTES * 60_000,
      );
    });

    it('an explicitly set interval wins over the lean default', () => {
      const env = parseEnv({
        ...VALID_ENV,
        QUEUE_PROFILE: 'lean',
        STUCK_TICKET_CHECK_INTERVAL_MS: '120000',
      });

      expect(env.STUCK_TICKET_CHECK_INTERVAL_MS).toBe(120_000);
      expect(env.LATENCY_CHECK_INTERVAL_MS).toBe(300_000);
    });

    it('leaves daily sweeps alone in lean', () => {
      const env = parseEnv({ ...VALID_ENV, QUEUE_PROFILE: 'lean' });

      expect(env.PURGE_CHECK_INTERVAL_MS).toBe(86_400_000);
      expect(env.TRIAL_EMAIL_CHECK_INTERVAL_MS).toBe(86_400_000);
      expect(env.META_TOKEN_REFRESH_INTERVAL_MS).toBe(86_400_000);
    });

    it('does not mutate the source environment', () => {
      const source = { ...VALID_ENV, QUEUE_PROFILE: 'lean' };

      parseEnv(source);

      expect(source).not.toHaveProperty('STUCK_TICKET_CHECK_INTERVAL_MS');
    });
  });

  describe('PLATFORM_ALERT_EMAIL', () => {
    it('is unset by default', () => {
      expect(parseEnv(VALID_ENV).PLATFORM_ALERT_EMAIL).toBeUndefined();
    });

    it('rejects a non-email value', () => {
      expect(() =>
        parseEnv({ ...VALID_ENV, PLATFORM_ALERT_EMAIL: 'not-an-email' }),
      ).toThrow();
    });
  });
});
