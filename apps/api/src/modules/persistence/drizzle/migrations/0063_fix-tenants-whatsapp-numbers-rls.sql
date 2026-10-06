-- Removes RLS that was applied directly against the cloud database outside
-- this migration history. tenants and whatsapp_numbers are deliberately
-- NOT tenant-scoped by design (see their table.ts header comments): tenants
-- defines what a tenant *is*, and whatsapp_numbers is looked up BEFORE any
-- tenant context exists. The isolation policy required
-- id = current_setting('app.tenant_id'), which no INSERT could ever satisfy
-- on the row that establishes that id, breaking tenant signup.
--> statement-breakpoint
DROP POLICY IF EXISTS "tenants_isolation" ON "tenants";--> statement-breakpoint
ALTER TABLE "tenants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "whatsapp_numbers_isolation" ON "whatsapp_numbers";--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" DISABLE ROW LEVEL SECURITY;
