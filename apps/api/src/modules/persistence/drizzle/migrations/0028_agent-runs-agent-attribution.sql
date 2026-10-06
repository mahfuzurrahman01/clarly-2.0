-- F9 step 2: which agent answered a turn, and with which published
-- configuration version.
--
-- Both nullable, and deliberately so: every row written before F9 has
-- neither, and backfilling them would mean inventing an attribution that
-- was never true. A run whose agent cannot be resolved still records the
-- run — telemetry is worth more than a clean column.
--
-- `agent_config_version` is the tenant-side counterpart to the existing
-- `prompt_version`: that one moves when the platform changes L0, this one
-- when a tenant publishes new configuration. Reading a metrics change
-- requires both, which is why they are separate columns rather than one
-- combined version string.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "agent_config_version" integer;--> statement-breakpoint

-- Per-agent metrics ("how is this agent doing since I changed it") always
-- filter by tenant first, then agent, then time — the same access shape
-- A9's existing rollups use.
CREATE INDEX IF NOT EXISTS "agent_runs_tenant_agent_created_idx"
  ON "agent_runs" ("tenant_id", "agent_id", "created_at" DESC)
  WHERE "agent_id" IS NOT NULL;
