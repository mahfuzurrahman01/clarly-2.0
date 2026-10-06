// Whether we are allowed to message a given customer, and recording when that
// changes.
//
// WHAT AN OPT-OUT BLOCKS, and what it deliberately does not:
//
//   blocked   agent auto-replies        we initiated the conversation logic
//   blocked   template sends            business-initiated by definition
//   allowed   a human replying inside the 24h service window
//   allowed   recording their inbound messages
//
// The last two are the ones worth defending. A customer who says STOP and then
// messages again ("actually, I need help") has re-opened the service window
// themselves — refusing to let a human answer would trap them with no way to
// reach anyone, which is a worse outcome than the one opt-out exists to
// prevent. Meta's own model draws the line the same place: opt-out governs
// business-initiated messaging, and a customer-initiated conversation is not
// that. Their messages are always recorded; losing what someone said because
// they had unsubscribed would be its own kind of failure.
//
// Opting out does NOT auto-reverse on a later message. Re-engagement is an
// explicit act — they send START, or an admin records it after speaking to
// them. Inferring consent from a message is exactly the inference that gets
// businesses fined.
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customers, type OptOutSource } from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  DEFAULT_CHANNEL,
  type ChannelKind,
} from '../channel/ports/channel-kind';

export interface CustomerConsent {
  customerId: string;
  /** Feature 16: consent is per (channel, identity). A WhatsApp STOP is not an Instagram STOP — they are different identities we cannot link. */
  channel: ChannelKind;
  phone: string;
  optedOutAt: Date | null;
  optOutSource: OptOutSource | null;
  /** F19: the narrower, marketing-specific opt-out — see isMarketingOptedOut(). */
  marketingOptedOutAt: Date | null;
}

@Injectable()
export class CustomerConsentService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /**
   * True when business-initiated messaging to this phone is not allowed.
   *
   * A phone with no customer row has never opted out — a customer we have
   * never heard from cannot have asked us to stop.
   */
  async isOptedOut(
    tenantId: string,
    phone: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ optedOutAt: customers.optedOutAt })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, tenantId),
              eq(customers.channel, channel),
              eq(customers.phone, phone),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0]?.optedOutAt != null;
  }

  /** Same question, when the caller already has the customer id rather than the phone. */
  async isCustomerOptedOut(
    tenantId: string,
    customerId: string,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({ optedOutAt: customers.optedOutAt })
          .from(customers)
          .where(
            and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)),
          )
          .limit(1),
      tenantId,
    );
    return rows[0]?.optedOutAt != null;
  }

  /** Records an opt-out. Idempotent: repeating STOP does not move the original timestamp, which is the one that matters for evidence. */
  async recordOptOut(
    tenantId: string,
    phone: string,
    source: OptOutSource,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerConsent> {
    const existing = await this.find(tenantId, phone, channel);
    if (existing?.optedOutAt) return existing;

    return this.write(
      tenantId,
      phone,
      { optedOutAt: new Date(), optOutSource: source },
      channel,
    );
  }

  /** Records an opt-in, clearing both fields — there is no such thing as a half-remembered consent state. */
  async recordOptIn(
    tenantId: string,
    phone: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerConsent> {
    return this.write(
      tenantId,
      phone,
      { optedOutAt: null, optOutSource: null },
      channel,
    );
  }

  async get(
    tenantId: string,
    phone: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerConsent | null> {
    return this.find(tenantId, phone, channel);
  }

  /**
   * F19 (Open Question 2): true when EITHER the global opt-out or the
   * marketing-specific one is set — marketing consent is the narrower gate,
   * so it inherits the global opt-out rather than duplicating it. False for
   * a customer id this tenant has never heard from, same reasoning as
   * `isOptedOut()`.
   */
  async isMarketingOptedOut(
    tenantId: string,
    customerId: string,
  ): Promise<boolean> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select({
            optedOutAt: customers.optedOutAt,
            marketingOptedOutAt: customers.marketingOptedOutAt,
          })
          .from(customers)
          .where(
            and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)),
          )
          .limit(1),
      tenantId,
    );
    const row = rows[0];
    return row?.optedOutAt != null || row?.marketingOptedOutAt != null;
  }

  /**
   * Sets or clears the marketing-only opt-out for a KNOWN customer id — the
   * merchant-facing `PATCH /customers/:id/marketing-consent` path. Unlike
   * `recordOptOut`/`recordOptIn` (phone-keyed, upsert-on-write, for a
   * customer who may not have a row yet), this always targets an existing
   * row: the controller's `requireCustomer()` has already 404'd otherwise.
   */
  async setMarketingOptOut(
    tenantId: string,
    customerId: string,
    optedOut: boolean,
  ): Promise<CustomerConsent | null> {
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(customers)
          .set({
            marketingOptedOutAt: optedOut ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)),
          )
          .returning(),
      tenantId,
    );
    return row ? toConsent(row) : null;
  }

  /**
   * The "STOP MARKETING"/"UNSUBSCRIBE" inbound keyword handler's write path
   * (F19). Idempotent like `recordOptOut` — a repeated keyword does not move
   * the original timestamp, which is the one that matters as evidence.
   */
  async recordMarketingOptOut(
    tenantId: string,
    phone: string,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerConsent> {
    const existing = await this.find(tenantId, phone, channel);
    if (existing?.marketingOptedOutAt) return existing;

    return this.write(
      tenantId,
      phone,
      { marketingOptedOutAt: new Date() },
      channel,
    );
  }

  private async find(
    tenantId: string,
    phone: string,
    channel: ChannelKind,
  ): Promise<CustomerConsent | null> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, tenantId),
              eq(customers.channel, channel),
              eq(customers.phone, phone),
            ),
          )
          .limit(1),
      tenantId,
    );
    return rows[0] ? toConsent(rows[0]) : null;
  }

  private async write(
    tenantId: string,
    phone: string,
    patch: Partial<{
      optedOutAt: Date | null;
      optOutSource: OptOutSource | null;
      marketingOptedOutAt: Date | null;
    }>,
    channel: ChannelKind = DEFAULT_CHANNEL,
  ): Promise<CustomerConsent> {
    // Upsert on (tenant, phone) rather than update: a customer can ask to stop
    // before we have ever recorded a profile for them, and losing that because
    // no row existed yet would be the exact failure this feature prevents.
    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(customers)
          .values({ tenantId, channel, phone, ...patch })
          .onConflictDoUpdate({
            target: [customers.tenantId, customers.channel, customers.phone],
            set: { ...patch, updatedAt: new Date() },
          })
          .returning(),
      tenantId,
    );
    return toConsent(row);
  }
}

function toConsent(row: typeof customers.$inferSelect): CustomerConsent {
  return {
    customerId: row.id,
    channel: row.channel,
    phone: row.phone,
    optedOutAt: row.optedOutAt,
    optOutSource: row.optOutSource,
    marketingOptedOutAt: row.marketingOptedOutAt,
  };
}
