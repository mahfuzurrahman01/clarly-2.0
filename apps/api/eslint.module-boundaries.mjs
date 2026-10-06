// @ts-check
// Lint-enforced module dependency rules from AI_PIPELINE_PLAN.md's "NestJS
// Module Boundaries" section (4 rules). Wired into apps/api/eslint.config.mjs
// and run in CI on every PR — see docs/decisions/F0-ci-test-strategy.md for
// why this exists from Feature 0 day one instead of "we'll add lint rules
// later": a boundary rule that's only a code comment erodes as soon as
// someone under deadline pressure adds the wrong import.
//
// Enforcement mechanism: `no-restricted-imports`, scoped per-directory via
// each config object's `files` glob. Every module directory matches exactly
// one of the five groups below, so there's no rule-merging ambiguity (ESLint
// flat config does NOT deep-merge same-key rules across matching config
// objects — the last one wins — so each group's ban list is written out in
// full rather than composed).
//
// Known limitation: this matches on the *import specifier text* (relative
// paths and bare package names), not fully-resolved file paths. That's
// sufficient today because every intra-repo import in apps/api is a plain
// relative import (no path aliases configured in tsconfig). If path aliases
// are introduced later, these patterns must be extended to match the alias
// form too — flagged here so it isn't silently forgotten.

/** Rule 3: nothing outside RetrievalModule may import pgvector-specific types. */
const PGVECTOR_PATHS = [
  {
    name: 'pgvector',
    message:
      'Rule 3 (AI_PIPELINE_PLAN.md): only RetrievalModule may import pgvector types — keeps the D3 Qdrant exit ramp open.',
  },
  {
    name: 'pgvector/pg',
    message:
      'Rule 3 (AI_PIPELINE_PLAN.md): only RetrievalModule may import pgvector types — keeps the D3 Qdrant exit ramp open.',
  },
];

/** Rule 4: nothing outside PersistenceModule/TenantContextModule may open a raw DB connection. */
const RAW_DB_PATHS = [
  {
    name: 'pg',
    message:
      'Rule 4 (AI_PIPELINE_PLAN.md): only PersistenceModule/TenantContextModule may open a raw DB connection. Use TenantContextService.withTenantTx() instead.',
  },
  {
    name: 'drizzle-orm/node-postgres',
    message:
      'Rule 4 (AI_PIPELINE_PLAN.md): only PersistenceModule/TenantContextModule may open a raw DB connection. Use TenantContextService.withTenantTx() instead.',
  },
  {
    name: '@supabase/supabase-js',
    message:
      'Rule 4 (AI_PIPELINE_PLAN.md): only PersistenceModule/TenantContextModule may open a raw DB connection. Use TenantContextService.withTenantTx() instead.',
  },
];

/**
 * Same as RAW_DB_PATHS minus the `@supabase/supabase-js` entry, for the two
 * modules with a legitimate, narrow need for a NON-DATABASE Supabase API
 * that Rule 4 wasn't written to cover:
 *
 *   - OnboardingModule (Feature 6) calls the Auth Admin API
 *     (`auth.admin.updateUserById(...)`) to set a fresh signup's
 *     `app_metadata.tenant_id`/`app_role` claims.
 *   - KnowledgeBaseModule (2026-08-15) calls Supabase Storage
 *     (`storage.from(bucket)`) to store KB source documents.
 *
 * Neither is a raw DB connection. Rule 4 exists to keep every actual
 * Postgres access path funneled through TenantContextService.withTenantTx()
 * for RLS/tenant-isolation reasons; the Auth Admin API touches Supabase's
 * own `auth.users` over HTTPS and Storage touches an object bucket over
 * HTTPS — neither goes near this app's Postgres. `pg`/
 * `drizzle-orm/node-postgres` stay banned in both modules — only the
 * supabase-js carve-out is narrowed, and only for these two.
 *
 * If a third module ever needs this, stop and check it is genuinely a
 * non-Postgres Supabase surface before adding it here.
 */
const RAW_DB_PATHS_EXCEPT_SUPABASE_JS = RAW_DB_PATHS.filter(
  (entry) => entry.name !== '@supabase/supabase-js',
);

/** Rule 1: ToolExecutionModule must not import AgentModule or PromptModule. */
const AGENT_PROMPT_PATTERNS = [
  {
    group: ['**/agent/**', '**/prompt/**'],
    message:
      'Rule 1 (AI_PIPELINE_PLAN.md): ToolExecutionModule must not import AgentModule or PromptModule — the execution/authorization boundary must have zero dependency on the prompt path.',
  },
];

/** Rule 2: LlmModule must not import RetrievalModule. */
const RETRIEVAL_PATTERN = [
  {
    group: ['**/retrieval/**'],
    message:
      'Rule 2 (AI_PIPELINE_PLAN.md): LlmModule must not import RetrievalModule — no implicit RAG-inside-the-provider.',
  },
];

export const moduleBoundaryConfigs = [
  // Group: modules/retrieval — exempt from rule 3 (it's the only pgvector
  // consumer), still subject to rule 4 (no raw DB client; retrieval reaches
  // Postgres through TenantContextModule like everything else).
  {
    files: ['src/modules/retrieval/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: RAW_DB_PATHS }],
    },
  },
  // Group: modules/persistence + modules/tenant-context — exempt from rule 4
  // (they ARE the raw-connection boundary), still subject to rule 3 (no
  // pgvector-specific types outside retrieval).
  {
    files: ['src/modules/persistence/**/*.ts', 'src/modules/tenant-context/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: PGVECTOR_PATHS }],
    },
  },
  // Group: modules/tool-execution — general bans (3+4) plus rule 1.
  {
    files: ['src/modules/tool-execution/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...RAW_DB_PATHS, ...PGVECTOR_PATHS], patterns: AGENT_PROMPT_PATTERNS },
      ],
    },
  },
  // Group: modules/llm — general bans (3+4) plus rule 2.
  {
    files: ['src/modules/llm/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...RAW_DB_PATHS, ...PGVECTOR_PATHS], patterns: RETRIEVAL_PATTERN },
      ],
    },
  },
  // Group: modules/onboarding + modules/storage — general bans (3+4),
  // narrowed on the `@supabase/supabase-js` half of rule 4 only (see
  // RAW_DB_PATHS_EXCEPT_SUPABASE_JS's own comment for why).
  //
  // `storage` rather than `knowledge-base` since F13: SupabaseStorageAdapter
  // moved out of the KB module when inbound WhatsApp media became a second
  // consumer of the port. The carve-out follows the file that needs it — the
  // KB module itself no longer imports the Supabase client at all.
  {
    files: ['src/modules/onboarding/**/*.ts', 'src/modules/storage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...RAW_DB_PATHS_EXCEPT_SUPABASE_JS, ...PGVECTOR_PATHS] },
      ],
    },
  },
  // Group: everyone else — general bans (3+4) only.
  {
    files: ['src/modules/**/*.ts'],
    ignores: [
      'src/modules/retrieval/**',
      'src/modules/persistence/**',
      'src/modules/tenant-context/**',
      'src/modules/tool-execution/**',
      'src/modules/llm/**',
      'src/modules/onboarding/**',
      'src/modules/storage/**',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: [...RAW_DB_PATHS, ...PGVECTOR_PATHS] }],
    },
  },
];
