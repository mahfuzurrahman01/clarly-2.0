"use client";

import type { MetaSdkConfig } from "@/lib/env";
import type { ConnectedWhatsappNumber } from "@/lib/api/whatsapp-connect";
import type { SocialChannel } from "@/lib/api/social-channels";
import { useTranslations } from "@/lib/i18n/provider";
import { SocialChannelsPanel } from "./social-channels-panel";
import { useFacebookSdk } from "./use-facebook-sdk";
import { WhatsappNumbersPanel } from "./whatsapp-numbers-panel";

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md"
    >
      <h2 id={id} className="font-display text-lg font-medium tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function ChannelsSettings({
  config,
  numbers,
  socialChannels,
}: {
  config: MetaSdkConfig | null;
  numbers: ConnectedWhatsappNumber[];
  socialChannels: SocialChannel[];
}) {
  const t = useTranslations();
  // One SDK load shared by both flows.
  const sdk = useFacebookSdk(config);

  return (
    <div className="space-y-6">
      <Section
        id="channels-whatsapp"
        title={t.channels.whatsappTitle}
        description={t.channels.whatsappDescription}
      >
        <WhatsappNumbersPanel initial={numbers} config={config} sdk={sdk} />
      </Section>
      <Section
        id="channels-social"
        title={t.channels.socialTitle}
        description={t.channels.socialDescription}
      >
        <SocialChannelsPanel initial={socialChannels} config={config} sdk={sdk} />
      </Section>
    </div>
  );
}
