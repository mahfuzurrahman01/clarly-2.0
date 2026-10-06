import { defineConfig } from '@playwright/test';

/**
 * T9 (Playwright): E2E tests for Gulf parity flows.
 *
 * These tests verify the full HTTP pipeline — webhook ingest through to
 * API responses — against a real running server. They do NOT test
 * delivery-to-end-user (no browser UI), just the server's contract.
 *
 * Requires: `pnpm start` (or `pnpm dev`) on a non-default port to avoid
 * colliding with the dev server.
 */
export default defineConfig({
  globalSetup: './test/e2e/global-setup',
  testDir: './test/e2e',
  testMatch: '*.e2e-spec.ts',
  timeout: 30_000,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    extraHTTPHeaders: {
      'x-webhook-verify': 'e2e-test-mode',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
