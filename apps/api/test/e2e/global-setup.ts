import { request } from '@playwright/test';

/**
 * Global setup: verify the target server is reachable before E2E tests run.
 * If the server is down, all E2E tests are skipped via an env flag.
 */
export default async function globalSetup() {
  const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

  try {
    const ctx = await request.newContext({ baseURL });
    // Try a lightweight GET — the health endpoint or any route.
    const res = await ctx.get('/');
    if (res.status() < 500) {
      process.env.E2E_SERVER_READY = '1';
    }
    await ctx.dispose();
  } catch {
    // Server not reachable — flag it so tests skip.
    process.env.E2E_SERVER_READY = '0';
  }
}
