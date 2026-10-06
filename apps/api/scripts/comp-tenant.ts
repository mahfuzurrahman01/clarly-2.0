/**
 * Launch billing backend (Lane A): sets or clears a tenant's `comped` flag
 * — a platform-operator override that grants (or revokes) AI-reply
 * entitlement independent of Stripe status, per tenant-subscriptions.table.ts's
 * own header comment. There is deliberately NO API endpoint for this: comping
 * a tenant bypasses billing entirely, and the only defensible way to do that
 * is a human running a script against their own machine/credentials, not a
 * route any authenticated admin (even a compromised one) could hit.
 *
 * Boots a real Nest application context (same pattern as seed-tenant.ts) so
 * the write goes through TenantContextService.withTenantTx() — the real,
 * RLS-scoped path — rather than a raw psql UPDATE that would need someone to
 * remember `SET app.tenant_id` by hand.
 *
 * Usage — comp a tenant (creates the subscription row if none exists yet,
 * against the platform's oldest-seeded plan, same "default plan" convention
 * migration 0046's backfill uses):
 *   npm run comp-tenant --workspace=api -- \
 *     --tenant-id <uuid> --reason "Pilot customer, comped through Q1" [--by "riaz"]
 *
 * Usage — un-comp a tenant (does NOT touch status/trialEndsAt — a tenant
 * un-comped back onto a lapsed Stripe status is exactly what un-comping
 * should do: revert to whatever billing state is actually true):
 *   npm run comp-tenant --workspace=api -- --tenant-id <uuid> --uncomp
 *
 * `--by` defaults to the OS user running the script (`whoami`) — every comp
 * is attributable to a person, never anonymous, per the audit-trail
 * reasoning in migration 0045's header comment.
 */
import 'dotenv/config';
import { userInfo } from 'node:os';
import { eq } from 'drizzle-orm';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  plans,
  tenants,
  tenantSubscriptions,
} from '../src/modules/persistence/drizzle/schema';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';

interface Args {
  tenantId: string;
  uncomp: boolean;
  reason?: string;
  by: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(flag.slice(2), true);
    } else {
      flags.set(flag.slice(2), next);
      i += 1;
    }
  }

  const tenantId = flags.get('tenant-id');
  if (typeof tenantId !== 'string') {
    throw new Error('--tenant-id <uuid> is required.');
  }

  const uncomp = flags.get('uncomp') === true;
  const reason = flags.get('reason');
  if (!uncomp && typeof reason !== 'string') {
    throw new Error(
      '--reason "<why>" is required when comping a tenant (not required for --uncomp) — every comp must be traceable to a reason, not just a person.',
    );
  }

  const by = flags.get('by');
  return {
    tenantId,
    uncomp,
    reason: typeof reason === 'string' ? reason : undefined,
    by: typeof by === 'string' ? by : userInfo().username,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const persistence = app.get(PersistenceService);
    const tenantContext = app.get(TenantContextService);

    const [tenant] = await persistence.runAdminQuery((db) =>
      db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, args.tenantId))
        .limit(1),
    );
    if (!tenant) {
      throw new Error(`No tenant with id ${args.tenantId}.`);
    }

    const existing = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(tenantSubscriptions)
          .where(eq(tenantSubscriptions.tenantId, args.tenantId))
          .limit(1),
      args.tenantId,
    );

    if (args.uncomp) {
      if (existing.length === 0) {
        console.log(
          `tenant ${args.tenantId} has no subscription row — nothing to un-comp.`,
        );
        return;
      }
      await tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(tenantSubscriptions)
            .set({
              comped: false,
              compedBy: null,
              compedAt: null,
              compedReason: null,
              updatedAt: new Date(),
            })
            .where(eq(tenantSubscriptions.tenantId, args.tenantId)),
        args.tenantId,
      );
      console.log(
        `tenant ${args.tenantId} un-comped by ${args.by} — entitlement now follows its real status/trialEndsAt again.`,
      );
      return;
    }

    if (existing.length > 0) {
      await tenantContext.withTenantTx(
        (tx) =>
          tx
            .update(tenantSubscriptions)
            .set({
              comped: true,
              compedBy: args.by,
              compedAt: new Date(),
              compedReason: args.reason,
              updatedAt: new Date(),
            })
            .where(eq(tenantSubscriptions.tenantId, args.tenantId)),
        args.tenantId,
      );
      console.log(
        `tenant ${args.tenantId} comped by ${args.by}: "${args.reason}"`,
      );
      return;
    }

    // No subscription row at all — create one, comped, against the
    // platform's oldest-seeded plan. Same convention migration 0046's
    // backfill uses: the plan_id FK must point somewhere, but it is never
    // read for a comped tenant's entitlement decision.
    const [defaultPlan] = await persistence.runAdminQuery((db) =>
      db.select({ id: plans.id }).from(plans).orderBy(plans.createdAt).limit(1),
    );
    if (!defaultPlan) {
      throw new Error(
        'No plan has been seeded yet — comp-tenant needs at least one plans row to satisfy tenant_subscriptions.plan_id. Seed a plan first.',
      );
    }

    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tenantSubscriptions).values({
          tenantId: args.tenantId,
          planId: defaultPlan.id,
          stripeCustomerId: null,
          status: 'incomplete',
          comped: true,
          compedBy: args.by,
          compedAt: new Date(),
          compedReason: args.reason,
        }),
      args.tenantId,
    );
    console.log(
      `tenant ${args.tenantId} had no subscription row — created one, comped by ${args.by}: "${args.reason}"`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `comp-tenant failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
