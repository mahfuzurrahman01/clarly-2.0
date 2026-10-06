import { getConsoleSession } from "@/lib/session";
import {
  BOOKINGS_PAGE_SIZE,
  getBookingSettings,
  listBookingServices,
  listBookings,
} from "@/lib/api/bookings";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { getServerNow } from "@/lib/time";
import { PageHeader } from "@/components/shell/page-header";
import { BookingsManager } from "@/components/bookings/bookings-manager";

export const dynamic = "force-dynamic";

/** v2 S2: the bookings agenda. Agents and admins both work it. */
export default async function BookingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const now = getServerNow();

  const [settings, services, upcoming, requests] = await Promise.all([
    getBookingSettings(session.token),
    listBookingServices(session.token),
    listBookings(
      { from: new Date(now).toISOString(), order: "asc", limit: BOOKINGS_PAGE_SIZE },
      session.token,
    ),
    listBookings({ status: "requested", limit: 100 }, session.token),
  ]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <PageHeader
        eyebrow={t.bookings.eyebrow}
        title={t.bookings.title}
        description={t.bookings.description}
      />
      <div className="mt-8">
        <BookingsManager
          initial={upcoming}
          initialRequestCount={requests.items.length}
          services={services}
          mode={settings.mode}
          timeZone={settings.timeZone}
          now={now}
        />
      </div>
    </div>
  );
}
