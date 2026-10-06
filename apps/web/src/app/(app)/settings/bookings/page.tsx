import { getConsoleSession } from "@/lib/session";
import {
  getBookingSettings,
  getCalendarStatus,
  listBookingServices,
} from "@/lib/api/bookings";
import { getTenant } from "@/lib/api/onboarding";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { BookingSettingsManager } from "@/components/bookings/booking-settings-manager";
import { BookingServicesManager } from "@/components/bookings/booking-services-manager";
import { CalendarConnectionCard } from "@/components/bookings/calendar-connection-card";

export const dynamic = "force-dynamic";

export default async function BookingSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ calendar?: string }>;
}) {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const { calendar } = await searchParams;
  const [settings, services, calendarStatus, tenant] = await Promise.all([
    getBookingSettings(session.token),
    listBookingServices(session.token),
    getCalendarStatus(session.token),
    getTenant(session.token),
  ]);
  const canEdit = session.role === "admin";

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.bookings.settings.eyebrow}
        title={t.bookings.settings.title}
        description={t.bookings.settings.description}
      />
      <BookingSettingsManager initial={settings} canEdit={canEdit} />
      <BookingServicesManager initial={services} canEdit={canEdit} defaultCurrency={tenant.currency} />
      <CalendarConnectionCard initial={calendarStatus} canEdit={canEdit} result={calendar ?? null} />
    </div>
  );
}
