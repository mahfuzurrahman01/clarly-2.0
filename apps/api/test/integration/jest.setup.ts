// Integration tests run outside NestJS bootstrap (main.ts), so nothing else
// loads .env for them. CI sets DATABASE_URL/REDIS_URL directly as job env
// vars (see .github/workflows/ci.yml) where this is a harmless no-op;
// locally it picks up apps/api/.env for `npm run test:integration`.
import 'dotenv/config';
import { assertLocalIntegrationDatabase } from './db-guard';

// Runs before any spec module is loaded, so a non-local DATABASE_URL aborts
// every test file before it can seed or delete a single row.
assertLocalIntegrationDatabase(process.env);

// jest-integration.json's `maxWorkers: 1` (added alongside T10, Feature 3):
// several suites boot a full NestJS module including WebhookModule, which
// registers a real BullMQ Worker for the `respond-path` queue. Multiple
// test files running as separate Jest worker processes each start their
// OWN Worker instance against the SAME queue name in the SAME shared
// Redis — those workers compete for every job in that queue, including
// ones created by a sibling file's test, not just their own. T10's
// debounce-coalescing tests are the first ones sensitive enough to timing
// to actually surface this (a job getting picked up/retried by a
// different file's worker mid-coalescing-window produced flaky,
// order-dependent failures) — forcing serial execution is the real fix,
// not a workaround for one flaky assertion.
