// Builds the bundle: every row this platform holds for one tenant, as one
// JSON document.
//
// The hard requirement is COMPLETENESS. An export that quietly omits a table
// is worse than no export at all — it answers a legal obligation with
// something that looks right and is not, and nobody discovers the gap until it
// matters. So the table list below is explicit and exhaustive rather than
// derived from a schema walk: a new table added to the schema will NOT
// silently start appearing here, and the guard test in this module's spec
// fails when the schema grows without this list growing with it. Finding out
// from a red test is the entire point.
//
// Reads go through withTenantTx like everything else, so RLS scopes every
// query to the requesting tenant even though the tenant id is already known.
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  agentKbDocuments,
  agentRuns,
  agentVersions,
  agents,
  answerFeedback,
  auditLog,
  conversationIntake,
  conversationOutcomes,
  conversations,
  customerAttributes,
  customerLabels,
  customers,
  dataExports,
  kbDocuments,
  messageTemplates,
  messages,
  notifications,
  products,
  tenantPolicy,
  tenantSubscriptions,
  tenantTools,
  tenantWebhooks,
  tickets,
  whatsappNumbers,
  socialChannels,
  commentEvents,
  commentActions,
  commentAutomationSettings,
  commentPostRules,
  storeConnections,
  storeSyncJobs,
  segments,
  campaigns,
  campaignRecipients,
  orders,
  orderItems,
  tenantOrderSettings,
  courierConnections,
  shipments,
  shipmentStatusEvents,
  shipmentNotifications,
  deliveryNotificationSettings,
  tenantBookingSettings,
  bookingServices,
  calendarConnections,
  bookings,
  webWidgets,
} from '../persistence/drizzle/schema';
import { TenantContextService } from '../tenant-context/tenant-context.service';

/**
 * Every tenant-owned table, by the name it appears under in the bundle.
 *
 * Deliberately omitted, each for a reason a reader should be able to check:
 *   - `tenants` — the workspace's own row is emitted separately as metadata.
 *   - `plans` — a platform catalog, identical for every tenant and not theirs.
 *   - `stripe_customer_tenant_map` — internal routing for Stripe webhooks; it
 *     holds no tenant content and exposing the mapping helps nobody.
 *   - `webhook_message_dedup` — transient idempotency keys with no meaning
 *     outside the ingest path.
 *   - `meta_data_deletion_requests` — platform-level record of deletion
 *     requests Meta sent on behalf of a Facebook user (Gulf T7). Keyed by a
 *     Meta user, not a tenant; there is no tenant_id to export by.
 *   - `kb_chunks` — embeddings derived from `kb_documents`, which ARE
 *     exported. Vectors are not the tenant's content, they are our
 *     representation of it, and they would multiply the bundle size for
 *     something no recipient can use.
 */
const EXPORTED_TABLES = {
  agents,
  agent_versions: agentVersions,
  agent_kb_documents: agentKbDocuments,
  agent_runs: agentRuns,
  answer_feedback: answerFeedback,
  audit_log: auditLog,
  conversations,
  conversation_intake: conversationIntake,
  conversation_outcomes: conversationOutcomes,
  customers,
  customer_attributes: customerAttributes,
  // Feature 18. A tenant's own commercial read on their customers — and, once
  // a human has overridden one, a judgement a person on their team made and
  // would expect to take with them. Exported on the same footing as
  // `customers` itself.
  customer_labels: customerLabels,
  data_exports: dataExports,
  kb_documents: kbDocuments,
  message_templates: messageTemplates,
  messages,
  notifications,
  tenant_policy: tenantPolicy,
  tenant_subscriptions: tenantSubscriptions,
  tenant_tools: tenantTools,
  tenant_webhooks: tenantWebhooks,
  tickets,
  whatsapp_numbers: whatsappNumbers,
  // Feature 16. Included on the same footing as `whatsapp_numbers`, and for
  // the same reason: a tenant's connected channels are their own
  // configuration, and the credential column is AES-GCM ciphertext that is
  // inert without the platform key — never plaintext.
  social_channels: socialChannels,
  // Gulf T8 (F23). The comments the tenant's automation handled, what it did
  // to each, and the tenant's own rules — their customers' content and their
  // configuration, on the same footing as `messages` and `tenant_policy`.
  comment_events: commentEvents,
  comment_actions: commentActions,
  comment_automation_settings: commentAutomationSettings,
  comment_post_rules: commentPostRules,
  // Feature 20 (Product Catalog & Stock). The tenant's own product catalog —
  // their prices, stock levels, SKUs, and descriptions. This is their
  // commercial data, on the same footing as `customers` and `messages`.
  products,
  // Feature 24 (Store Integrations). The tenant's own store links and the
  // sync history against them. Included on the same footing as
  // `social_channels`: the token/secret columns are AES-GCM ciphertext that is
  // inert without the platform key — never plaintext.
  store_connections: storeConnections,
  store_sync_jobs: storeSyncJobs,
  // F19 (D7.5). A broadcast list and the record of who was actually
  // messaged is customer data, on the same footing as `messages` and
  // `customer_labels`. `segments`' definition is the tenant's own saved
  // query, not customer content, but is exported alongside for the same
  // reason `tenant_policy` is — it is the tenant's own configuration.
  segments,
  campaigns,
  campaign_recipients: campaignRecipients,
  // F25 (D2.5). A merchant's order history is their data on the same footing
  // as `customers` — PDPL/D15d — and the mode row is their own configuration,
  // exported for the same reason `tenant_policy` is.
  tenant_order_settings: tenantOrderSettings,
  orders,
  order_items: orderItems,
  // F26 (D7). The tenant's own courier links, the parcels they are tracking,
  // and what their customers were told about them — customer data on the same
  // footing as `messages`, plus the tenant's own configuration. The
  // `credentials` / `webhook_secret` columns export as AES-GCM ciphertext,
  // inert without the platform key, exactly as `store_connections` already
  // does. `courier_webhook_events` is deliberately absent: it has no
  // tenant_id, being written before a tenant is known.
  courier_connections: courierConnections,
  shipments,
  shipment_status_events: shipmentStatusEvents,
  shipment_notifications: shipmentNotifications,
  delivery_notification_settings: deliveryNotificationSettings,
  // Clarly 2.0 S2 (bookings). Appointments are customer data on the same
  // footing as `orders`; settings and services are the tenant's own
  // configuration. `calendar_connections.credentials_encrypted` exports as
  // AES-GCM ciphertext, inert without the platform key, exactly as
  // `store_connections` and `courier_connections` already do.
  tenant_booking_settings: tenantBookingSettings,
  booking_services: bookingServices,
  calendar_connections: calendarConnections,
  bookings,
  // Clarly 2.0 S3: the tenant's own website widget configuration. Visitor
  // conversations are already in `conversations` / `messages` (channel `web`).
  web_widgets: webWidgets,
} as const;

export type ExportedTableName = keyof typeof EXPORTED_TABLES;

export interface AssembledExport {
  content: Buffer;
  rowCounts: Record<string, number>;
}

@Injectable()
export class DataExportAssemblerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** The table names this export covers — exposed so a test can assert the list has not fallen behind the schema. */
  static exportedTableNames(): string[] {
    return Object.keys(EXPORTED_TABLES);
  }

  async assemble(tenantId: string): Promise<AssembledExport> {
    const tables: Record<string, unknown[]> = {};
    const rowCounts: Record<string, number> = {};

    for (const [name, table] of Object.entries(EXPORTED_TABLES)) {
      const rows = await this.tenantContext.withTenantTx(
        (tx) => tx.select().from(table).where(eq(table.tenantId, tenantId)),
        tenantId,
      );
      tables[name] = rows;
      rowCounts[name] = rows.length;
    }

    const bundle = {
      // Version the format from day one: a recipient parsing this in two years
      // needs to know which shape they are holding.
      formatVersion: 1,
      tenantId,
      generatedAt: new Date().toISOString(),
      // Named so a reader can tell "this table was empty" from "this table was
      // never included" without diffing against a schema they do not have.
      tables: Object.keys(EXPORTED_TABLES),
      rowCounts,
      data: tables,
      notes: {
        storedFiles:
          'Knowledge-base documents and message attachments are listed here by their metadata rows only. The file bytes are not embedded in this bundle; download them from their own endpoints while the workspace is open.',
        embeddings:
          'Vector embeddings derived from knowledge-base documents are not included. They are a representation of the exported documents, not additional content.',
      },
    };

    return {
      content: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'),
      rowCounts,
    };
  }
}
