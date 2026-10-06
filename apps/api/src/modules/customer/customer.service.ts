// Product shell (CustomerModule, T13): "Persistent customer profile ...
// shared across all conversations and tickets for that customer, not
// re-derived per conversation." Same get-or-create-by-unique-key pattern
// as Feature 4's ConversationService.getOrCreateConversation() —
// onConflictDoUpdate touching updatedAt makes it one round trip, race-safe,
// with no separate select-then-insert step.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customers } from '../persistence/drizzle/schema';
import {
  DEFAULT_CHANNEL,
  type ChannelKind,
} from '../channel/ports/channel-kind';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { CustomerRecord, UpdateCustomerInput } from './customer.dto';

@Injectable()
export class CustomerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Reuses the existing row for an identity already seen (T13's own verify
   * line) rather than creating a duplicate.
   *
   * Feature 16: `channel` is part of the identity key. It defaults to
   * 'whatsapp' so every existing caller keeps its exact behaviour, and so
   * that a Messenger PSID which happens to look like a phone number can
   * never merge into a different person's WhatsApp profile.
   */
  async getOrCreateByPhone(
    tenantId: string,
    phone: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerRecord> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(customers)
          .values({ tenantId, channel, phone })
          .onConflictDoUpdate({
            target: [customers.tenantId, customers.channel, customers.phone],
            set: { updatedAt: new Date() },
          })
          .returning(),
      tenantId,
    );

    return toRecord(row);
  }

  async getCustomer(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerRecord | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(customers)
          .where(
            and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Null when no row matched — an unknown id, or one belonging to another
   * tenant that RLS filtered out. Deliberately mirrors getCustomer() above:
   * `returning()` yields `[]` on no match, so destructuring it hands back
   * `undefined`, and mapping that would throw rather than report absence.
   * Callers translate null into a 404; the service stays free of HTTP.
   */
  async updateCustomer(
    tenantId: string,
    customerId: string,
    input: UpdateCustomerInput,
  ): Promise<CustomerRecord | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(customers)
          .set({
            ...(input.name !== undefined && { name: input.name }),
            ...(input.tags !== undefined && { tags: input.tags }),
            ...(input.notes !== undefined && { notes: input.notes }),
            updatedAt: new Date(),
          })
          .where(
            and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)),
          )
          .returning(),
      tenantId,
    );

    return row ? toRecord(row) : null;
  }
}

function toRecord(row: typeof customers.$inferSelect): CustomerRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    channel: row.channel,
    phone: row.phone,
    name: row.name,
    tags: row.tags,
    notes: row.notes,
  };
}
