import { getConsoleSession } from "@/lib/session";
import { ApiError } from "@/lib/api/client";
import {
  DELIVERY_NOTIFICATIONS_OFF,
  getDeliveryNotificationSettings,
  listCourierConnections,
  type DeliveryNotificationSettings,
} from "@/lib/api/delivery";
import { listTemplates, type MessageTemplateRecord } from "@/lib/api/templates";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { CourierConnectionsManager } from "@/components/delivery/courier-connections-manager";
import { DeliveryNotificationsForm } from "@/components/delivery/delivery-notifications-form";

export const dynamic = "force-dynamic";

/**
 * A tenant that has never opened this screen has no
 * `delivery_notification_settings` row. The opt-in default is off, so a
 * missing row resolves to off — never to "we don't know", and never to on.
 */
function offWhenMissing(err: unknown): DeliveryNotificationSettings {
  if (err instanceof ApiError && err.status === 404) {
    return DELIVERY_NOTIFICATIONS_OFF;
  }
  throw err;
}

/**
 * Only an approved WhatsApp utility template can carry a shipment update:
 * the send path refuses anything else (wrong category is a WhatsApp policy
 * violation as well as a mis-bill), so offering the rest in the picker would
 * only produce silently-skipped notifications.
 */
function usableForDeliveryUpdates(
  template: MessageTemplateRecord,
): boolean {
  return (
    template.kind === "whatsapp_template" &&
    template.category === "UTILITY" &&
    template.approvalStatus === "approved"
  );
}

export default async function DeliverySettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  const [connections, notifications, templates] = await Promise.all([
    listCourierConnections(session.token),
    getDeliveryNotificationSettings(session.token).catch(offWhenMissing),
    listTemplates("whatsapp_template", session.token),
  ]);

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow={t.delivery.settings.eyebrow}
        title={t.delivery.settings.title}
        description={t.delivery.settings.description}
      />
      <CourierConnectionsManager initial={connections} />
      <DeliveryNotificationsForm
        initial={notifications}
        templates={templates.filter(usableForDeliveryUpdates)}
      />
    </div>
  );
}
