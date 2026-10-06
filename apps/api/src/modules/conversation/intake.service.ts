// Product shell (ConversationModule, F10): storing what the agent collected.
//
// The model reports values against the tenant's own field keys. This service
// is where that report meets the configuration: a key nobody asked for is
// DROPPED rather than stored, because a model inventing `customer_mood` and
// having it appear on a ticket as if a human configured it is worse than
// losing the value.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  conversationIntake,
  customerAttributes,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { IntakeField } from '../agent-config/intake-fields';

@Injectable()
export class IntakeService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * Writes captured values to the right table for each field's scope.
   *
   * Latest wins: a customer correcting their order number replaces the wrong
   * one rather than leaving two rows nobody can choose between.
   */
  async record(input: {
    tenantId: string;
    conversationId: string;
    customerId: string;
    fields: IntakeField[];
    captured: Record<string, string>;
  }): Promise<{ stored: string[]; ignored: string[] }> {
    const byKey = new Map(input.fields.map((field) => [field.key, field]));
    const stored: string[] = [];
    const ignored: string[] = [];

    for (const [key, rawValue] of Object.entries(input.captured)) {
      const field = byKey.get(key);
      const value = rawValue.trim();
      // An empty string is the model saying "I did not get one" in a shape
      // the schema allows; storing it would show a human a field that looks
      // answered and is not.
      if (!field || value.length === 0) {
        ignored.push(key);
        continue;
      }

      if (field.scope === 'customer') {
        await this.upsertCustomerAttribute(
          input.tenantId,
          input.customerId,
          key,
          value,
        );
      } else {
        await this.upsertConversationIntake(
          input.tenantId,
          input.conversationId,
          key,
          value,
        );
      }
      stored.push(key);
    }

    return { stored, ignored };
  }

  /** Everything collected for one conversation, plus the durable facts about its customer. */
  async getForConversation(
    tenantId: string,
    conversationId: string,
    customerId: string,
  ): Promise<
    { key: string; value: string; scope: 'conversation' | 'customer' }[]
  > {
    const [perConversation, perCustomer] = await Promise.all([
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              key: conversationIntake.fieldKey,
              value: conversationIntake.value,
            })
            .from(conversationIntake)
            .where(
              and(
                eq(conversationIntake.conversationId, conversationId),
                eq(conversationIntake.tenantId, tenantId),
              ),
            ),
        tenantId,
      ),
      this.tenantContext.withTenantTx(
        (tx) =>
          tx
            .select({
              key: customerAttributes.fieldKey,
              value: customerAttributes.value,
            })
            .from(customerAttributes)
            .where(
              and(
                eq(customerAttributes.customerId, customerId),
                eq(customerAttributes.tenantId, tenantId),
              ),
            ),
        tenantId,
      ),
    ]);

    return [
      ...perConversation.map((row) => ({
        ...row,
        scope: 'conversation' as const,
      })),
      ...perCustomer.map((row) => ({ ...row, scope: 'customer' as const })),
    ];
  }

  private async upsertConversationIntake(
    tenantId: string,
    conversationId: string,
    fieldKey: string,
    value: string,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(conversationIntake)
          .values({ tenantId, conversationId, fieldKey, value })
          .onConflictDoUpdate({
            target: [
              conversationIntake.conversationId,
              conversationIntake.fieldKey,
            ],
            set: { value, capturedAt: new Date() },
          }),
      tenantId,
    );
  }

  private async upsertCustomerAttribute(
    tenantId: string,
    customerId: string,
    fieldKey: string,
    value: string,
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(customerAttributes)
          .values({ tenantId, customerId, fieldKey, value })
          .onConflictDoUpdate({
            target: [
              customerAttributes.customerId,
              customerAttributes.fieldKey,
            ],
            set: { value, capturedAt: new Date() },
          }),
      tenantId,
    );
  }
}
