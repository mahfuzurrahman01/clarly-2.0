/**
 * One-off dev script: populates the EXISTING dev tenant
 * (3f6de92a-2789-4de2-8971-63da3478afb5) so it looks like a real,
 * fully-populated professional WhatsApp AI Agent account instead of a bare
 * dev tenant — business profile, KB, catalog, customers, conversations,
 * orders, tickets, templates and tool authorizations.
 *
 * Deliberately narrower than seed-tenant.ts: it does not create a tenant,
 * does not touch auth/tenant_subscriptions, and is not meant to be re-run
 * generically for arbitrary tenants — the business identity and content
 * below are written for this one tenant. Follows the same pattern as
 * seed-tenant.ts: a real Nest application context, RLS-scoped writes through
 * TenantContextService.withTenantTx(), non-tenant-scoped writes through
 * PersistenceService.runAdminQuery(), and real encryption for the fake BSP
 * credential.
 *
 * Usage:
 *   npm run db:seed:professional --workspace=api
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import {
  tenants,
  whatsappNumbers,
  kbDocuments,
  products,
  customers,
  customerLabels,
  conversations,
  messages,
  orders,
  orderItems,
  tickets,
  messageTemplates,
  tenantOrderSettings,
} from '../src/modules/persistence/drizzle/schema';
import { PersistenceService } from '../src/modules/persistence/persistence.service';
import { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';
import { TenantPolicyService } from '../src/modules/onboarding/tenant-policy.service';
import { RetrievalIngestService } from '../src/modules/retrieval/retrieval-ingest.service';
import { BspCredentialsEncryptionService } from '../src/modules/whatsapp/bsp-credentials-encryption.service';
import { CatalogToolSeederService } from '../src/modules/catalog/catalog-tool-seeder.service';
import { OrderToolSeederService } from '../src/modules/order/order-tool-seeder.service';
import { CourierToolSeederService } from '../src/modules/courier/courier-tool-seeder.service';

const TENANT_ID = '3f6de92a-2789-4de2-8971-63da3478afb5';
const BUSINESS_NAME = 'Zenith Coffee Roasters';

const TONE_PERSONA =
  'You are the WhatsApp support voice of Zenith Coffee Roasters, a specialty coffee roastery based in Riyadh. Warm, precise, and a little proud of the craft — never salesy. Keep replies short and scannable for WhatsApp. Use the customer\'s name when known. Default to English unless the customer writes in Arabic, then mirror their language. Never invent a price, stock level, or order detail that is not in the tools or knowledge base.';

interface KbDoc {
  filename: string;
  content: string;
}

const KB_DOCS: KbDoc[] = [
  {
    filename: 'shipping-policy.txt',
    content: `Zenith Coffee Roasters — Shipping Policy

We roast to order out of our Riyadh roastery and ship across Saudi Arabia.

- Orders placed before 2 PM (Riyadh time) roast and ship the same day.
- Riyadh metro: next-day delivery via SMSA, SAR 15 flat rate.
- Other KSA cities: 2-4 business days via Aramex, SAR 25 flat rate.
- Free shipping on orders over SAR 250.
- We do not currently ship outside Saudi Arabia.
- Once an order ships you will receive a WhatsApp message with the tracking link.
- Whole bean orders are vacuum-sealed at roast time to preserve freshness in transit.`,
  },
  {
    filename: 'return-and-refund-policy.txt',
    content: `Zenith Coffee Roasters — Returns & Refunds

Because coffee is a perishable, roast-to-order product, we do not accept returns of opened bags.

- Damaged or incorrect items: tell us within 48 hours of delivery with a photo, and we will send a free replacement or refund in full.
- Unopened, unroasted-to-order items (equipment, drippers, grinders, cups) may be returned within 14 days of delivery for a full refund, provided the item is unused and in its original packaging.
- Refunds are issued to the original payment method within 5-7 business days of us receiving the returned item.
- Subscription boxes can be paused or cancelled at any time before the next billing date with no penalty.
- To start a return, message us on WhatsApp with your order number.`,
  },
  {
    filename: 'faq.txt',
    content: `Zenith Coffee Roasters — Frequently Asked Questions

Q: How fresh is the coffee when it ships?
A: We roast in small batches and ship within 24-48 hours of roasting. Every bag has a roast date printed on it.

Q: Do you offer decaf?
A: Yes — our Decaf Colombian is a Swiss Water Process decaf, ground or whole bean.

Q: Can I choose the grind size?
A: Yes. When ordering, tell us whole bean, drip/filter grind, espresso grind, or French press grind and we will grind to order.

Q: Do you sell wholesale to cafes?
A: Yes, message us and our team will follow up with wholesale pricing and minimum order quantities.

Q: What payment methods do you accept?
A: Cash on delivery for WhatsApp orders. Card and Apple Pay are available on our website.

Q: How do I pause or cancel my coffee subscription?
A: Message us with your order number and the change you'd like, or manage it directly from your account on our website.`,
  },
  {
    filename: 'product-care-guide.txt',
    content: `Zenith Coffee Roasters — Product Care Guide

Storing your coffee:
- Keep beans in the resealable valve bag they arrive in, away from light, heat, and moisture.
- Do not refrigerate or freeze opened bags — condensation ruins flavor.
- Best consumed within 3-4 weeks of the roast date for peak flavor.

Grinders:
- Clean the burrs of your grinder every 2-3 weeks with a grinder-safe cleaning tablet or a dry brush.
- Avoid grinding anything oily (like flavored beans) if you plan to also grind for filter coffee, as oils build up on the burrs.

French press and pour-over gear:
- Hand wash glass and stainless components; avoid abrasive scrubbers on glass carafes.
- Replace paper filters every brew; rinse and air-dry metal V60 filters after each use.
- Descale kettles and machines monthly if you are in a hard-water area.`,
  },
];

interface ProductSeed {
  id: string;
  name: string;
  sku: string;
  description: string;
  price: string;
  stock: number;
  stockStatus: 'in_stock' | 'out_of_stock' | 'low_stock' | 'pre_order';
  category: string;
  tags: string[];
}

const PRODUCTS: ProductSeed[] = [
  {
    id: randomUUID(),
    name: 'Ethiopian Yirgacheffe — Whole Bean 250g',
    sku: 'ZCR-ETH-WB-250',
    description:
      'Bright, floral single-origin from the Yirgacheffe region. Notes of jasmine, bergamot, and lemon. Light roast.',
    price: '62.00',
    stock: 140,
    stockStatus: 'in_stock',
    category: 'Single Origin',
    tags: ['whole-bean', 'light-roast', 'single-origin'],
  },
  {
    id: randomUUID(),
    name: 'Colombian Supremo — Whole Bean 250g',
    sku: 'ZCR-COL-WB-250',
    description:
      'Balanced and nutty with notes of caramel and red apple. Medium roast, our best-seller.',
    price: '54.00',
    stock: 200,
    stockStatus: 'in_stock',
    category: 'Single Origin',
    tags: ['whole-bean', 'medium-roast', 'single-origin', 'best-seller'],
  },
  {
    id: randomUUID(),
    name: 'Sumatra Mandheling — Whole Bean 250g',
    sku: 'ZCR-SUM-WB-250',
    description:
      'Full-bodied and earthy with low acidity and notes of dark chocolate and cedar. Dark roast.',
    price: '58.00',
    stock: 90,
    stockStatus: 'in_stock',
    category: 'Single Origin',
    tags: ['whole-bean', 'dark-roast', 'single-origin'],
  },
  {
    id: randomUUID(),
    name: 'House Blend — Ground 250g',
    sku: 'ZCR-HSE-GR-250',
    description:
      'Our signature everyday blend — smooth, chocolatey, easy to love. Ground for drip/filter brewing.',
    price: '45.00',
    stock: 300,
    stockStatus: 'in_stock',
    category: 'Blends',
    tags: ['ground', 'medium-roast', 'blend', 'best-seller'],
  },
  {
    id: randomUUID(),
    name: 'Espresso Blend — Whole Bean 1kg',
    sku: 'ZCR-ESP-WB-1000',
    description:
      'A rich, syrupy blend built for espresso — notes of dark cocoa and brown sugar with a heavy body.',
    price: '165.00',
    stock: 60,
    stockStatus: 'in_stock',
    category: 'Blends',
    tags: ['whole-bean', 'dark-roast', 'espresso', 'bulk'],
  },
  {
    id: randomUUID(),
    name: 'Decaf Colombian — Ground 250g',
    sku: 'ZCR-DEC-GR-250',
    description:
      'Swiss Water Process decaf with the same balanced, nutty profile as our Colombian Supremo.',
    price: '50.00',
    stock: 75,
    stockStatus: 'in_stock',
    category: 'Decaf',
    tags: ['ground', 'decaf', 'medium-roast'],
  },
  {
    id: randomUUID(),
    name: 'Pour-Over Starter Kit',
    sku: 'ZCR-EQP-POK',
    description:
      'Everything you need to start pour-over at home: ceramic dripper, 40 paper filters, and a 250g bag of House Blend.',
    price: '220.00',
    stock: 25,
    stockStatus: 'in_stock',
    category: 'Equipment',
    tags: ['equipment', 'gift', 'bundle'],
  },
  {
    id: randomUUID(),
    name: 'V60 Ceramic Dripper',
    sku: 'ZCR-EQP-V60',
    description: 'Classic ceramic conical dripper for clean, bright pour-over cups.',
    price: '95.00',
    stock: 40,
    stockStatus: 'in_stock',
    category: 'Equipment',
    tags: ['equipment'],
  },
  {
    id: randomUUID(),
    name: 'Stainless Steel French Press 1L',
    sku: 'ZCR-EQP-FP1L',
    description: 'Double-walled insulated French press, keeps coffee hot for longer.',
    price: '130.00',
    stock: 35,
    stockStatus: 'in_stock',
    category: 'Equipment',
    tags: ['equipment'],
  },
  {
    id: randomUUID(),
    name: 'Precision Burr Grinder',
    sku: 'ZCR-EQP-GRIND',
    description:
      'Electric conical burr grinder with 15 grind settings, from espresso to French press.',
    price: '340.00',
    stock: 18,
    stockStatus: 'low_stock',
    category: 'Equipment',
    tags: ['equipment', 'electric'],
  },
  {
    id: randomUUID(),
    name: 'Monthly Coffee Subscription — 250g',
    sku: 'ZCR-SUB-MO-250',
    description:
      "A different single-origin roasted and shipped to your door every month. Pause or cancel anytime.",
    price: '180.00',
    stock: 999,
    stockStatus: 'in_stock',
    category: 'Subscriptions',
    tags: ['subscription', 'gift'],
  },
  {
    id: randomUUID(),
    name: 'Discovery Trio Gift Set — 3x100g',
    sku: 'ZCR-GFT-TRIO',
    description:
      'Three 100g bags — Ethiopian Yirgacheffe, Colombian Supremo, and Sumatra Mandheling — in a gift box.',
    price: '145.00',
    stock: 55,
    stockStatus: 'in_stock',
    category: 'Gift Sets',
    tags: ['gift', 'sampler'],
  },
  {
    id: randomUUID(),
    name: 'Cold Brew Concentrate 500ml',
    sku: 'ZCR-CLD-500',
    description: 'Ready-to-pour cold brew concentrate, mix 1:1 with water or milk over ice.',
    price: '48.00',
    stock: 80,
    stockStatus: 'in_stock',
    category: 'Ready to Drink',
    tags: ['cold-brew', 'ready-to-drink'],
  },
  {
    id: randomUUID(),
    name: 'Zenith Reusable Cup 12oz',
    sku: 'ZCR-MER-CUP12',
    description: 'Double-walled reusable cup with the Zenith logo, keeps drinks hot or cold.',
    price: '65.00',
    stock: 120,
    stockStatus: 'in_stock',
    category: 'Merchandise',
    tags: ['merchandise', 'gift'],
  },
];

interface CustomerSeed {
  id: string;
  name: string;
  phone: string;
  tags: string[];
  label?: 'hot' | 'warm' | 'cold';
}

const CUSTOMERS: CustomerSeed[] = [
  { id: randomUUID(), name: 'Faisal Al-Otaibi', phone: '966501234501', tags: ['repeat-customer'], label: 'hot' },
  { id: randomUUID(), name: 'Noura Al-Qahtani', phone: '966501234502', tags: ['subscriber'], label: 'warm' },
  { id: randomUUID(), name: 'Yousef Al-Harbi', phone: '966501234503', tags: [], label: 'cold' },
  { id: randomUUID(), name: 'Layla Al-Zahrani', phone: '966501234504', tags: ['wholesale-lead'], label: 'hot' },
  { id: randomUUID(), name: 'Khalid Bin Salem', phone: '966501234505', tags: ['repeat-customer'], label: 'warm' },
  { id: randomUUID(), name: 'Reem Al-Mutairi', phone: '966501234506', tags: ['vip'], label: 'hot' },
  { id: randomUUID(), name: 'Abdulrahman Al-Ghamdi', phone: '966501234507', tags: [] },
  { id: randomUUID(), name: 'Hessa Al-Dosari', phone: '966501234508', tags: ['subscriber'], label: 'warm' },
];

function findCustomer(name: string): CustomerSeed {
  const customer = CUSTOMERS.find((c) => c.name === name);
  if (!customer) throw new Error(`Seed data bug: no customer named "${name}"`);
  return customer;
}

function findProduct(sku: string): ProductSeed {
  const product = PRODUCTS.find((p) => p.sku === sku);
  if (!product) throw new Error(`Seed data bug: no product with SKU "${sku}"`);
  return product;
}

interface ConversationSeed {
  id: string;
  customer: CustomerSeed;
  handoverState: 'agent' | 'human';
  turns: Array<{
    role: 'user' | 'assistant' | 'human_agent';
    content: string;
  }>;
}

function conversationOf(name: string): ConversationSeed {
  const customer = findCustomer(name);
  return { id: randomUUID(), customer, handoverState: 'agent', turns: [] };
}

const CONVERSATIONS: ConversationSeed[] = [
  {
    ...conversationOf('Faisal Al-Otaibi'),
    turns: [
      { role: 'user', content: 'Hi, is the Colombian Supremo in stock in whole bean?' },
      {
        role: 'assistant',
        content:
          'Hi Faisal! Yes, the Colombian Supremo 250g whole bean is in stock (SAR 54). Would you like ground or whole bean, and how many bags?',
      },
      { role: 'user', content: '2 bags whole bean please, same address as last time' },
      {
        role: 'assistant',
        content:
          "Got it — 2x Colombian Supremo 250g whole bean, SAR 108 total, shipping to your address on file. I'll place this as pending approval and our team will confirm shortly.",
      },
    ],
  },
  {
    ...conversationOf('Noura Al-Qahtani'),
    turns: [
      { role: 'user', content: 'Can I pause my subscription for next month? Traveling.' },
      {
        role: 'assistant',
        content:
          'Of course — I can pause your Monthly Coffee Subscription for next month. Would you like it to resume automatically the month after, or should I wait for you to message us?',
      },
      { role: 'user', content: 'Resume automatically please' },
      {
        role: 'assistant',
        content:
          "Done! Your subscription is paused for next month and will resume automatically the month after. Have a great trip!",
      },
    ],
  },
  {
    ...conversationOf('Yousef Al-Harbi'),
    turns: [
      { role: 'user', content: 'My order arrived but the bag was torn and beans spilled everywhere' },
      {
        role: 'assistant',
        content:
          "I'm really sorry to hear that, Yousef. Could you share a quick photo of the damaged bag and your order number? We'll send a free replacement right away.",
      },
      { role: 'user', content: 'order #ZCR-10231, sending photo now' },
      {
        role: 'human_agent',
        content:
          'Hi Yousef, this is Sara from the Zenith team — I can see the photo, that\'s on us. Replacement is going out today at no charge, tracking to follow.',
      },
    ],
  },
  {
    ...conversationOf('Layla Al-Zahrani'),
    turns: [
      { role: 'user', content: 'Hello, do you do wholesale pricing for cafes? We need about 20kg/month' },
      {
        role: 'assistant',
        content:
          "Hi Layla, yes — we do wholesale for cafes. Let me connect you with our wholesale team who can put together pricing for 20kg/month. Could you share your cafe name and city?",
      },
      { role: 'user', content: 'Layla\'s Corner, Jeddah' },
      {
        role: 'assistant',
        content:
          "Thank you! I've flagged this for our wholesale team — someone will reach out within 1 business day with pricing and minimum order details.",
      },
    ],
  },
  {
    ...conversationOf('Reem Al-Mutairi'),
    turns: [
      { role: 'user', content: 'What grind size should I ask for if I use a Chemex?' },
      {
        role: 'assistant',
        content:
          'For a Chemex, ask for a medium-coarse filter grind — similar to sea salt. We can grind any of our beans to that spec when you order.',
      },
      { role: 'user', content: 'Perfect, one bag of the Ethiopian Yirgacheffe ground for Chemex then' },
      {
        role: 'assistant',
        content:
          'One bag of Ethiopian Yirgacheffe 250g, ground medium-coarse for Chemex, SAR 62. Placing that now — you\'ll get a confirmation shortly.',
      },
    ],
  },
];

interface OrderSeed {
  id: string;
  reference: string;
  customer: CustomerSeed;
  conversationId: string | null;
  status: 'pending_approval' | 'confirmed' | 'rejected' | 'expired' | 'cancelled' | 'fulfilled' | 'failed';
  items: Array<{ sku: string; quantity: number }>;
  city: string;
  address: string;
}

const ORDERS: OrderSeed[] = [
  {
    id: randomUUID(),
    reference: 'ZCR-10228',
    customer: findCustomer('Faisal Al-Otaibi'),
    conversationId: CONVERSATIONS[0].id,
    status: 'pending_approval',
    items: [{ sku: 'ZCR-COL-WB-250', quantity: 2 }],
    city: 'Riyadh',
    address: 'Al Olaya District, King Fahd Rd, Building 14, Riyadh',
  },
  {
    id: randomUUID(),
    reference: 'ZCR-10229',
    customer: findCustomer('Noura Al-Qahtani'),
    conversationId: CONVERSATIONS[1].id,
    status: 'fulfilled',
    items: [{ sku: 'ZCR-SUB-MO-250', quantity: 1 }],
    city: 'Riyadh',
    address: 'Al Malqa District, Prince Turki Rd, Villa 7, Riyadh',
  },
  {
    id: randomUUID(),
    reference: 'ZCR-10231',
    customer: findCustomer('Yousef Al-Harbi'),
    conversationId: CONVERSATIONS[2].id,
    status: 'fulfilled',
    items: [{ sku: 'ZCR-HSE-GR-250', quantity: 1 }, { sku: 'ZCR-EQP-V60', quantity: 1 }],
    city: 'Jeddah',
    address: 'Al Rawdah District, Palestine St, Apt 22, Jeddah',
  },
  {
    id: randomUUID(),
    reference: 'ZCR-10233',
    customer: findCustomer('Reem Al-Mutairi'),
    conversationId: CONVERSATIONS[4].id,
    status: 'confirmed',
    items: [{ sku: 'ZCR-ETH-WB-250', quantity: 1 }],
    city: 'Riyadh',
    address: 'Al Nakheel District, Al Takhassusi St, Riyadh',
  },
  {
    id: randomUUID(),
    reference: 'ZCR-10235',
    customer: findCustomer('Khalid Bin Salem'),
    conversationId: null,
    status: 'cancelled',
    items: [{ sku: 'ZCR-EQP-GRIND', quantity: 1 }],
    city: 'Dammam',
    address: 'Al Faisaliyah District, King Saud St, Dammam',
  },
];

interface TicketSeed {
  customer: CustomerSeed;
  conversationId: string | null;
  escalationReason: string;
  status: 'OPEN' | 'CLAIMED' | 'RESOLVED';
  note: string;
}

const TICKETS: TicketSeed[] = [
  {
    customer: findCustomer('Yousef Al-Harbi'),
    conversationId: CONVERSATIONS[2].id,
    escalationReason: 'CUSTOMER_COMPLAINT',
    status: 'RESOLVED',
    note: 'Torn bag on delivery, replacement shipped same day. Order #ZCR-10231.',
  },
  {
    customer: findCustomer('Layla Al-Zahrani'),
    conversationId: CONVERSATIONS[3].id,
    escalationReason: 'EXPLICIT_USER_REQUEST',
    status: 'CLAIMED',
    note: 'Wholesale pricing request, ~20kg/month, cafe in Jeddah. Assigned to sales.',
  },
  {
    customer: findCustomer('Abdulrahman Al-Ghamdi'),
    conversationId: null,
    escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    status: 'OPEN',
    note: 'Asked about corporate gifting for 50+ recipients — outside current KB coverage.',
  },
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const persistence = app.get(PersistenceService);
    const tenantContext = app.get(TenantContextService);
    const tenantPolicy = app.get(TenantPolicyService);
    const encryption = app.get(BspCredentialsEncryptionService);
    const retrievalIngest = app.get(RetrievalIngestService);
    const catalogToolSeeder = app.get(CatalogToolSeederService);
    const orderToolSeeder = app.get(OrderToolSeederService);
    const courierToolSeeder = app.get(CourierToolSeederService);

    // 1. Business identity on the tenant row itself.
    await persistence.runAdminQuery((db) =>
      db.update(tenants).set({ name: BUSINESS_NAME }).where(eq(tenants.id, TENANT_ID)),
    );
    console.log(`tenant            renamed -> "${BUSINESS_NAME}"`);

    // 2. Policy row — confidence threshold + brand-voice persona.
    await tenantPolicy.upsert(TENANT_ID, {
      confidenceThreshold: 0.72,
      tonePersonaOverride: TONE_PERSONA,
    });
    console.log('tenant_policy     upserted (confidenceThreshold 0.72, persona set)');

    // 3. WhatsApp number, only if this tenant doesn't already have one —
    //    phone_number_id is globally unique, so re-running must not violate it.
    const [existingNumber] = await persistence.runAdminQuery((db) =>
      db.select().from(whatsappNumbers).where(eq(whatsappNumbers.tenantId, TENANT_ID)).limit(1),
    );
    if (existingNumber) {
      console.log(`whatsapp_number   already present (${existingNumber.phoneNumberId}) — left untouched`);
    } else {
      const phoneNumberId = `398${TENANT_ID.replace(/-/g, '').slice(0, 12)}`;
      await persistence.runAdminQuery((db) =>
        db.insert(whatsappNumbers).values({
          tenantId: TENANT_ID,
          phoneNumberId,
          bspCredentialsEncrypted: encryption.encrypt({
            accessToken: 'DEV_SEED_FAKE_TOKEN_DO_NOT_USE',
          }),
          connectionState: 'active',
          wabaId: `waba_${TENANT_ID.slice(0, 8)}`,
          displayPhoneNumber: '966112345678',
          verifiedName: BUSINESS_NAME,
          paymentMethodAttached: true,
          qualityRating: 'GREEN',
          messagingLimitTier: 'TIER_10K',
          nameStatus: 'APPROVED',
          messagingHealth: 'AVAILABLE',
        }),
      );
      console.log(`whatsapp_number   created (${phoneNumberId}, fake credentials encrypted)`);
    }

    // 4. Knowledge base documents, ingested synchronously. Clears any
    //    same-filename row left by a prior partial run first (e.g. the
    //    embedder being unreachable mid-ingest) so re-running this script
    //    after such a failure doesn't pile up orphaned uploaded-but-not-
    //    ingested rows.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.delete(kbDocuments).where(
          and(
            eq(kbDocuments.tenantId, TENANT_ID),
            inArray(kbDocuments.filename, KB_DOCS.map((d) => d.filename)),
          ),
        ),
      TENANT_ID,
    );
    let totalChunks = 0;
    for (const doc of KB_DOCS) {
      const kbDocumentId = randomUUID();
      const content = Buffer.from(doc.content, 'utf-8');
      await tenantContext.withTenantTx(
        (tx) =>
          tx.insert(kbDocuments).values({
            id: kbDocumentId,
            tenantId: TENANT_ID,
            filename: doc.filename,
            storageKey: `${TENANT_ID}/${kbDocumentId}`,
            mimeType: 'text/plain',
            sizeBytes: content.byteLength,
            status: 'uploaded',
          }),
        TENANT_ID,
      );
      // Best-effort: this dev DB's runtime role (app_user) is not the owner
      // of kb_chunks, so PartitionLifecycleService.ensurePartitionForTenant()
      // — called on every ingest, for every tenant, per pg-vector-store.ts —
      // fails the RLS-setup DDL even once the partition exists (that step
      // needs table ownership, which app_user does not have here). That's a
      // pre-existing environment/privilege gap affecting KB ingestion for
      // every tenant in this DB, not something this seed script can or
      // should fix (would mean reassigning ownership of a shared table).
      // The kb_documents row itself still lands either way, so the KB tab
      // shows real document names/policies even if this environment can't
      // finish embedding them right now.
      try {
        const { chunkCount } = await retrievalIngest.ingestDocument({
          tenantId: TENANT_ID,
          kbDocumentId,
          content,
          mimeType: 'text/plain',
        });
        totalChunks += chunkCount;
        console.log(`kb_document       ${doc.filename} -> ${chunkCount} chunks`);
      } catch (error) {
        await tenantContext.withTenantTx(
          (tx) =>
            tx
              .update(kbDocuments)
              .set({ status: 'failed' })
              .where(eq(kbDocuments.id, kbDocumentId)),
          TENANT_ID,
        );
        console.log(
          `kb_document       ${doc.filename} -> row created, ingest FAILED (${
            error instanceof Error ? error.message : String(error)
          })`,
        );
      }
    }
    console.log(`                  ${totalChunks} chunks indexed in total`);

    // 5. Product catalog.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(products).values(
          PRODUCTS.map((p) => ({
            id: p.id,
            tenantId: TENANT_ID,
            name: p.name,
            sku: p.sku,
            description: p.description,
            price: p.price,
            currency: 'SAR' as const,
            stock: p.stock,
            stockStatus: p.stockStatus,
            category: p.category,
            tags: p.tags,
            isActive: true,
          })),
        ),
      TENANT_ID,
    );
    console.log(`products          ${PRODUCTS.length} inserted`);

    // 6. Customers + labels.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(customers).values(
          CUSTOMERS.map((c) => ({
            id: c.id,
            tenantId: TENANT_ID,
            channel: 'whatsapp' as const,
            phone: c.phone,
            name: c.name,
            tags: c.tags,
          })),
        ),
      TENANT_ID,
    );
    const labeled = CUSTOMERS.filter((c) => c.label);
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(customerLabels).values(
          labeled.map((c) => ({
            tenantId: TENANT_ID,
            customerId: c.id,
            label: c.label!,
            agentLabel: c.label!,
            agentEvaluatedAt: new Date(),
          })),
        ),
      TENANT_ID,
    );
    console.log(`customers         ${CUSTOMERS.length} inserted (${labeled.length} labeled)`);

    // 7. Conversations + messages.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(conversations).values(
          CONVERSATIONS.map((c) => ({
            id: c.id,
            tenantId: TENANT_ID,
            channel: 'whatsapp' as const,
            customerPhone: c.customer.phone,
            handoverState: c.handoverState,
            lastInboundAt: new Date(),
          })),
        ),
      TENANT_ID,
    );
    let totalMessages = 0;
    for (const conversation of CONVERSATIONS) {
      const rows = conversation.turns.map((turn, index) => ({
        tenantId: TENANT_ID,
        conversationId: conversation.id,
        role: turn.role,
        content: turn.content,
        bspMessageId: turn.role === 'user' ? `wamid.SEED_${conversation.id.slice(0, 8)}_${index}` : null,
        deliveryStatus: turn.role === 'user' ? null : ('delivered' as const),
        deliveryUpdatedAt: turn.role === 'user' ? null : new Date(),
      }));
      await tenantContext.withTenantTx((tx) => tx.insert(messages).values(rows), TENANT_ID);
      totalMessages += rows.length;
    }
    console.log(`conversations     ${CONVERSATIONS.length} inserted`);
    console.log(`messages          ${totalMessages} inserted`);

    // 8. Orders + order items (prices snapshotted from the catalog above).
    for (const order of ORDERS) {
      const items = order.items.map(({ sku, quantity }) => {
        const product = findProduct(sku);
        const unitPrice = Number(product.price);
        return {
          product,
          quantity,
          unitPrice,
          lineTotal: unitPrice * quantity,
        };
      });
      const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);

      await tenantContext.withTenantTx(async (tx) => {
        await tx.insert(orders).values({
          id: order.id,
          tenantId: TENANT_ID,
          reference: order.reference,
          customerId: order.customer.id,
          conversationId: order.conversationId,
          status: order.status,
          contactName: order.customer.name!,
          contactPhone: order.customer.phone,
          city: order.city,
          address: order.address,
          paymentMethod: 'cod',
          paymentStatus: order.status === 'fulfilled' ? 'collected' : 'unpaid',
          subtotal: subtotal.toFixed(2),
          total: subtotal.toFixed(2),
          currency: 'SAR',
          idempotencyKey: `seed-${order.reference}`,
          contentHash: `seed-hash-${order.reference}`,
        });
        await tx.insert(orderItems).values(
          items.map((item) => ({
            tenantId: TENANT_ID,
            orderId: order.id,
            productId: item.product.id,
            productName: item.product.name,
            sku: item.product.sku,
            unitPrice: item.unitPrice.toFixed(2),
            currency: 'SAR',
            quantity: item.quantity,
            lineTotal: item.lineTotal.toFixed(2),
          })),
        );
      }, TENANT_ID);
    }
    console.log(`orders            ${ORDERS.length} inserted`);
    console.log(`order_items       ${ORDERS.reduce((n, o) => n + o.items.length, 0)} inserted`);

    // 9. Support tickets.
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(tickets).values(
          TICKETS.map((t) => ({
            tenantId: TENANT_ID,
            customerId: t.customer.id,
            conversationId: t.conversationId,
            escalationReason: t.escalationReason,
            status: t.status,
            note: t.note,
            claimedAt: t.status !== 'OPEN' ? new Date() : null,
            resolvedAt: t.status === 'RESOLVED' ? new Date() : null,
          })),
        ),
      TENANT_ID,
    );
    console.log(`tickets           ${TICKETS.length} inserted`);

    // 10. Message templates — a couple of approved WhatsApp templates plus a canned reply.
    //     NOTE: `approved` here is seed data, not Meta's word. These names must also
    //     exist (APPROVED, same language) on the number's WABA or sends are refused
    //     by TemplateSendService (ISSUE-002; Meta #132001 otherwise).
    await tenantContext.withTenantTx(
      (tx) =>
        tx.insert(messageTemplates).values([
          {
            tenantId: TENANT_ID,
            kind: 'whatsapp_template',
            name: 'order_shipped',
            language: 'en_US',
            category: 'UTILITY',
            body: 'Hi {{1}}, your Zenith Coffee Roasters order {{2}} has shipped! Track it here: {{3}}',
            variables: [
              { position: 1, label: 'Customer name', example: 'Faisal' },
              { position: 2, label: 'Order reference', example: 'ZCR-10228' },
              { position: 3, label: 'Tracking link', example: 'https://track.example.com/abc123' },
            ],
            approvalStatus: 'approved',
            syncedAt: new Date(),
          },
          {
            tenantId: TENANT_ID,
            kind: 'whatsapp_template',
            name: 'subscription_renewal_reminder',
            language: 'en_US',
            category: 'UTILITY',
            body: 'Hi {{1}}, your Zenith Coffee subscription renews on {{2}}. Reply here if you want to pause, skip, or change your roast.',
            variables: [
              { position: 1, label: 'Customer name', example: 'Noura' },
              { position: 2, label: 'Renewal date', example: 'Oct 1' },
            ],
            approvalStatus: 'approved',
            syncedAt: new Date(),
          },
          {
            tenantId: TENANT_ID,
            kind: 'canned_reply',
            name: 'Wholesale intro',
            language: 'en',
            body: "Thanks for your interest in Zenith Coffee wholesale! Could you share your cafe/shop name, city, and estimated monthly volume so our team can put together pricing?",
            variables: [],
            approvalStatus: 'local',
          },
        ]),
      TENANT_ID,
    );
    console.log('message_templates 3 inserted');

    // 11. Order mode + tool authorizations — the tenant_tools rows the agent
    //     loop actually checks (ToolExecutionService.authorize()).
    await tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(tenantOrderSettings)
          .values({ tenantId: TENANT_ID, mode: 'human_approval' })
          .onConflictDoUpdate({
            target: tenantOrderSettings.tenantId,
            set: { mode: 'human_approval', updatedAt: new Date() },
          }),
      TENANT_ID,
    );
    await catalogToolSeeder.seedForTenant(TENANT_ID);
    await orderToolSeeder.syncForMode(TENANT_ID, 'human_approval');
    await courierToolSeeder.seedForTenant(TENANT_ID);
    console.log('tenant_tools      lookup_product, create_order (human_approval), track_order enabled');

    console.log('\nDone.');
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `seed-professional-tenant failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
