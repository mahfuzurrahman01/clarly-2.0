import { getConsoleSession } from "@/lib/session";
import { ApiError } from "@/lib/api/client";
import { type ConnectedWhatsappNumber, listConnectedNumbers } from "@/lib/api/whatsapp-connect";
import { type SocialChannel, listSocialChannels } from "@/lib/api/social-channels";
import { getMetaSdkConfig } from "@/lib/env";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { ChannelsSettings } from "@/components/channels/channels-settings";

export const dynamic = "force-dynamic";

/**
 * A lapsed workspace gets 403 from EntitlementGuard on the WhatsApp routes;
 * show the page (its connect buttons then surface the upgrade dialog)
 * instead of the error screen. Anything else is a real failure.
 */
function emptyOnForbidden<T>(err: unknown): T[] {
  if (err instanceof ApiError && err.status === 403) return [];
  throw err;
}

export default async function ChannelsSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();
  const [numbers, socialChannels] = await Promise.all([
    listConnectedNumbers(session.token).catch(emptyOnForbidden<ConnectedWhatsappNumber>),
    listSocialChannels(session.token).catch(emptyOnForbidden<SocialChannel>),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.channels.eyebrow}
        title={t.channels.title}
        description={t.channels.description}
      />
      <ChannelsSettings
        config={getMetaSdkConfig()}
        numbers={numbers}
        socialChannels={socialChannels}
      />
    </div>
  );
}
