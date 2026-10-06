// Gulf T3 (D13): WhatsApp Business app coexistence. A message the business
// sends from the phone app arrives as an `smb_message_echoes` webhook; it is
// stored in the customer's conversation as human-sent and never reaches the
// respond path. Proven here against real Postgres + Redis with the REAL
// Meta parser and the REAL WhatsappChannelAdapter mapping (only signature
// verification is stubbed, the rest of MetaCloudAdapter being irrelevant).
//
// Run via `npm run test:integration`.
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { WhatsappChannelAdapter } from '../../src/modules/channel/whatsapp-channel.adapter';
import { CoreModule } from '../../src/modules/core/core.module';
import {
  conversations,
  messages,
  tenants,
  whatsappNumbers,
} from '../../src/modules/persistence/drizzle/schema';
import { PersistenceModule } from '../../src/modules/persistence/persistence.module';
import { PersistenceService } from '../../src/modules/persistence/persistence.service';
import { TenantContextModule } from '../../src/modules/tenant-context/tenant-context.module';
import { TenantContextService } from '../../src/modules/tenant-context/tenant-context.service';
import { RespondPathProducerService } from '../../src/modules/webhook/respond-path-producer.service';
import { WebhookIngestService } from '../../src/modules/webhook/webhook-ingest.service';
import { WebhookModule } from '../../src/modules/webhook/webhook.module';
import {
  parseMetaEnvelope,
  parseMetaMessageEchoes,
  parseMetaStatusUpdates,
} from '../../src/modules/whatsapp/meta-envelope.parser';
import {
  BspAdapter,
  type NormalizedInboundMessage,
  type NormalizedMessageEcho,
  type NormalizedStatusUpdate,
} from '../../src/modules/whatsapp/ports/bsp-adapter.port';

/** MetaCloudAdapter's parsing, verbatim, minus signature + Graph I/O. */
class ParsingOnlyMetaBsp extends BspAdapter {
  verifyWebhookSignature(): boolean {
    return true;
  }
  parseInboundWebhook(rawBody: string | Buffer): NormalizedInboundMessage[] {
    return parseMetaEnvelope(rawBody, 'ParsingOnlyMetaBsp');
  }
  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return parseMetaStatusUpdates(rawBody);
  }
  parseMessageEchoes(rawBody: string | Buffer): NormalizedMessageEcho[] {
    return parseMetaMessageEchoes(rawBody);
  }
  sendTextMessage(): never {
    throw new Error('not used');
  }
  sendTemplateMessage(): never {
    throw new Error('not used');
  }
  downloadMedia(): never {
    throw new Error('not used');
  }
}

describe('WhatsApp coexistence echoes (Gulf T3, D13)', () => {
  let moduleRef: TestingModule;
  let persistence: PersistenceService;
  let tenantContext: TenantContextService;
  let ingest: WebhookIngestService;
  let enqueueSpy: jest.SpyInstance;
  const adapter = new WhatsappChannelAdapter(new ParsingOnlyMetaBsp());

  const tenantId = randomUUID();
  const phoneNumberId = `pn-coex-${randomUUID()}`;
  const customer = '15557654321';

  function echoWebhook(id: string, text: string): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '15550001111',
                  phone_number_id: phoneNumberId,
                },
                message_echoes: [
                  {
                    from: '15550001111',
                    to: customer,
                    id,
                    timestamp: '1758276000',
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
              field: 'smb_message_echoes',
            },
          ],
        },
      ],
    });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule,
        PersistenceModule,
        TenantContextModule,
        WebhookModule,
      ],
    }).compile();
    await moduleRef.init();

    persistence = moduleRef.get(PersistenceService);
    tenantContext = moduleRef.get(TenantContextService);
    ingest = moduleRef.get(WebhookIngestService);
    enqueueSpy = jest.spyOn(
      moduleRef.get(RespondPathProducerService),
      'enqueue',
    );

    await persistence.runMigrations();
    await persistence.runAdminQuery((db) =>
      db.insert(tenants).values({ id: tenantId, name: 'Coexistence Tenant' }),
    );
    await persistence.runAdminQuery((db) =>
      db.insert(whatsappNumbers).values({
        tenantId,
        phoneNumberId,
        bspCredentialsEncrypted: 'not-real-ciphertext-for-this-test',
      }),
    );
  });

  afterAll(async () => {
    await persistence.runAdminQuery((db) =>
      db.delete(tenants).where(eq(tenants.id, tenantId)),
    );
    await moduleRef.close();
  });

  it('stores a phone-app echo as a human_agent message, pauses the agent, and enqueues nothing', async () => {
    const id = `wamid.${randomUUID()}`;

    const results = await ingest.ingest(
      adapter,
      echoWebhook(id, 'Sent from the WhatsApp Business app'),
      {},
    );

    expect(results).toEqual([
      { providerMessageId: id, outcome: 'business_app_echo_recorded' },
    ]);
    expect(enqueueSpy).not.toHaveBeenCalled();

    const [conversation] = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.tenantId, tenantId),
              eq(conversations.customerPhone, customer),
            ),
          ),
      tenantId,
    );
    expect(conversation.channel).toBe('whatsapp');
    expect(conversation.phoneNumberId).toBe(phoneNumberId);
    expect(conversation.handoverState).toBe('human');
    expect(conversation.handoverUserId).toBeNull();

    const rows = await tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(messages)
          .where(eq(messages.conversationId, conversation.id)),
      tenantId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'human_agent',
      content: 'Sent from the WhatsApp Business app',
      bspMessageId: id,
      deliveryStatus: 'sent',
      authorUserId: null,
    });
  });

  it('a redelivered echo is stored once', async () => {
    const id = `wamid.${randomUUID()}`;
    const body = echoWebhook(id, 'once');

    await ingest.ingest(adapter, body, {});
    const replay = await ingest.ingest(adapter, body, {});

    expect(replay).toEqual([{ providerMessageId: id, outcome: 'duplicate' }]);
    const rows = await tenantContext.withTenantTx(
      (tx) => tx.select().from(messages).where(eq(messages.bspMessageId, id)),
      tenantId,
    );
    expect(rows).toHaveLength(1);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
