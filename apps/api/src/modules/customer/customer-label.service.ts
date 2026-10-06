// Feature 18 (Intent Labeling): reading, agent-writing and human-overriding a
// customer's label.
//
// Lives in CustomerModule (T13) rather than a new top-level module: the label
// is a property of a customer, keyed by customer, read on the customer detail
// and the kanban ticket card. A module whose only table hangs off `customers`
// would be a module boundary drawn around a column.
//
// THE OVERRIDE-WINS RULE IS ENFORCED IN SQL, NOT IN TYPESCRIPT.
// `applyAgentSignal()` is a single INSERT ... ON CONFLICT whose `label`
// assignment is a CASE on `overridden_at`. The obvious alternative — read the
// row, check `overriddenAt`, then write — loses the race against a human
// pressing "override" in the console while a turn is in flight: the respond
// path reads "no override", the human commits theirs, the respond path writes
// over it, and the console silently shows the agent's label a second later.
// That is exactly the failure the locked precedence rule exists to prevent, so
// the check has to be part of the write, not before it.
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  customerLabels,
  type AgentCustomerLabel,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  deriveAgentLabel,
  type AgentLabelSignal,
} from './customer-label-derivation';
import type { CustomerLabelRecord } from './customer-label.dto';

@Injectable()
export class CustomerLabelService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Feature 18's write path, called from the respond path once per turn with
   * A5's already-computed decision — no batch job, no lag.
   *
   * Returns the resulting row, or `null` when the signal carried nothing about
   * the customer (see `deriveAgentLabel`: `error_forced` escalations). A
   * suppressed-by-override write still returns the row — it is a successful
   * no-op on `label`, not a failure — and still refreshes `agentLabel`/
   * `agentEvaluatedAt` so the console can show that the agent has kept looking
   * and what it would say.
   */
  async applyAgentSignal(
    tenantId: string,
    customerId: string,
    signal: AgentLabelSignal,
    now: Date = new Date(),
  ): Promise<CustomerLabelRecord | null> {
    const agentLabel = deriveAgentLabel(signal);
    if (!agentLabel) return null;
    return this.applyAgentLabel(tenantId, customerId, agentLabel, now);
  }

  /**
   * The agent-side label write itself, for a caller that already derived the
   * label from its own signal. Gulf T8 (D15b) uses it when a commenter answers
   * a private reply: the comment's classified intent is the signal. Same
   * single upsert and the same override-wins rule as applyAgentSignal().
   */
  async applyAgentLabel(
    tenantId: string,
    customerId: string,
    agentLabel: AgentCustomerLabel,
    now: Date = new Date(),
  ): Promise<CustomerLabelRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(customerLabels)
          .values({
            tenantId,
            customerId,
            label: agentLabel,
            agentLabel,
            agentEvaluatedAt: now,
          })
          .onConflictDoUpdate({
            target: [customerLabels.tenantId, customerLabels.customerId],
            set: {
              // The precedence rule, as one atomic expression.
              label: sql`case when ${customerLabels.overriddenAt} is null then excluded.label else ${customerLabels.label} end`,
              agentLabel: sql`excluded.agent_label`,
              agentEvaluatedAt: sql`excluded.agent_evaluated_at`,
              updatedAt: now,
            },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  /** Null when this customer has never been labelled — or belongs to another tenant, which RLS makes indistinguishable. */
  async get(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerLabelRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(customerLabels)
          .where(
            and(
              eq(customerLabels.tenantId, tenantId),
              eq(customerLabels.customerId, customerId),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * A human pins the label. From here on the agent stops writing `label` for
   * this customer until `clearOverride()` — the locked precedence rule.
   *
   * Upserts rather than updates: a human may label a customer the agent has
   * never had a turn with (someone they spoke to on the phone), and refusing
   * that would make the override endpoint depend on the agent having run first.
   */
  async override(
    tenantId: string,
    customerId: string,
    label: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<CustomerLabelRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(customerLabels)
          .values({
            tenantId,
            customerId,
            label,
            overriddenAt: now,
            overriddenBy: userId,
          })
          .onConflictDoUpdate({
            target: [customerLabels.tenantId, customerLabels.customerId],
            set: {
              label,
              overriddenAt: now,
              overriddenBy: userId,
              updatedAt: now,
            },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  /**
   * The human hands the customer back to the agent.
   *
   * The label immediately becomes the agent's current opinion
   * (`agentLabel`) rather than staying frozen at the human's value until the
   * customer happens to message again — "clear the override" means the agent's
   * answer applies, and making the tenant wait for an unpredictable next
   * inbound message to see it would look like the clear did nothing.
   * Falls back to the existing label when the agent has never evaluated this
   * customer (a human-only label with nothing to revert to).
   *
   * Null when there is no label row to clear.
   */
  async clearOverride(
    tenantId: string,
    customerId: string,
    now: Date = new Date(),
  ): Promise<CustomerLabelRecord | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(customerLabels)
          .set({
            label: sql`coalesce(${customerLabels.agentLabel}, ${customerLabels.label})`,
            overriddenAt: null,
            overriddenBy: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(customerLabels.tenantId, tenantId),
              eq(customerLabels.customerId, customerId),
            ),
          )
          .returning(),
      tenantId,
    );

    return row ? toRecord(row) : null;
  }
}

function toRecord(
  row: typeof customerLabels.$inferSelect,
): CustomerLabelRecord {
  return {
    customerId: row.customerId,
    label: row.label,
    // Derived, never stored: a `source` column and `overriddenAt` can drift
    // apart, and then nobody knows which one the precedence rule reads.
    source: row.overriddenAt ? 'human' : 'agent',
    overriddenAt: row.overriddenAt,
    overriddenBy: row.overriddenBy,
    agentLabel: row.agentLabel,
    agentEvaluatedAt: row.agentEvaluatedAt,
    updatedAt: row.updatedAt,
  };
}
