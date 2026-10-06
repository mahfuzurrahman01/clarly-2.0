"use client";

import { useId, useState } from "react";
import { AlertTriangle, CreditCard } from "lucide-react";
import { toast } from "sonner";
import type { MetaSdkConfig } from "@/lib/env";
import {
  type ConnectedWhatsappNumber,
  listConnectedNumbers,
} from "@/lib/api/whatsapp-connect";
import {
  type HealthTone,
  connectionProblem,
  connectionStateLabel,
  healthItems,
} from "@/lib/channels/whatsapp-health";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SdkStatusNote } from "./sdk-status-note";
import type { FacebookSdkState } from "./use-facebook-sdk";
import { WhatsappSignupButton } from "./whatsapp-signup-button";

const TONE_CLASS: Record<HealthTone, string> = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-destructive",
  neutral: "text-foreground",
};

const PIN_PATTERN = /^\d{6}$/;

export function WhatsappNumbersPanel({
  initial,
  config,
  sdk,
}: {
  initial: ConnectedWhatsappNumber[];
  config: MetaSdkConfig | null;
  sdk: FacebookSdkState;
}) {
  const t = useTranslations();
  const [numbers, setNumbers] = useState(initial);
  const configured = Boolean(config?.embeddedSignupConfigId);

  async function refresh() {
    try {
      setNumbers(await listConnectedNumbers());
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.channels.errorBody));
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <WhatsappSignupButton
            config={config}
            sdk={sdk}
            label={t.channels.connectWhatsapp}
            onConnected={refresh}
          />
          <WhatsappSignupButton
            config={config}
            sdk={sdk}
            coexistence
            variant="outline"
            label={t.channels.connectBusinessApp}
            onConnected={refresh}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t.channels.businessAppHint}</p>
        <SdkStatusNote sdk={sdk} configured={configured} />
      </div>

      {numbers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {t.channels.noWhatsappNumbers}
        </p>
      ) : (
        <>
          <ul className="space-y-3">
            {numbers.map((n) => (
              <li key={n.id}>
                <NumberCard number={n} config={config} sdk={sdk} onReconnected={refresh} />
              </li>
            ))}
          </ul>
          {/* Meta bills the tenant's own WABA (T3 step 7). */}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <CreditCard className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t.channels.paymentHint}
          </p>
        </>
      )}
    </div>
  );
}

function NumberCard({
  number,
  config,
  sdk,
  onReconnected,
}: {
  number: ConnectedWhatsappNumber;
  config: MetaSdkConfig | null;
  sdk: FacebookSdkState;
  onReconnected: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const problem = connectionProblem(number, t);
  const health = healthItems(number, t, locale);
  const title =
    (number.displayPhoneNumber ? `+${number.displayPhoneNumber}` : null) ??
    t.channels.phoneNumberIdTemplate.replace("{id}", number.phoneNumberId);
  const active = number.connectionState === "active";

  return (
    <article className="space-y-3 rounded-lg border border-border p-4" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium tabular-nums">{title}</span>
        {number.verifiedName ? (
          <span className="text-sm text-muted-foreground">{number.verifiedName}</span>
        ) : null}
        <span
          className={cn(
            "ms-auto rounded-full border px-2 py-0.5 text-xs",
            active
              ? "border-lime-ring/40 bg-lime-soft/70 text-lime-text"
              : "border-destructive/40 bg-destructive/5 text-destructive",
          )}
        >
          {connectionStateLabel(number.connectionState, t)}
        </span>
      </div>

      {number.displayPhoneNumber ? (
        <p className="text-xs text-muted-foreground">
          {t.channels.phoneNumberIdTemplate.replace("{id}", number.phoneNumberId)}
        </p>
      ) : null}

      {problem ? (
        <ReconnectBanner
          number={number}
          message={problem}
          config={config}
          sdk={sdk}
          onReconnected={onReconnected}
        />
      ) : null}

      {health.length > 0 ? (
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          {health.map((item) => (
            <div key={item.key}>
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className={cn("font-medium", TONE_CLASS[item.tone])}>{item.value}</dd>
            </div>
          ))}
        </dl>
      ) : active ? (
        <p className="text-xs text-muted-foreground">{t.channels.healthPending}</p>
      ) : null}

      {number.paymentMethodAttached === false ? (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <CreditCard className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t.channels.paymentMissing}
        </p>
      ) : null}
    </article>
  );
}

function ReconnectBanner({
  number,
  message,
  config,
  sdk,
  onReconnected,
}: {
  number: ConnectedWhatsappNumber;
  message: string;
  config: MetaSdkConfig | null;
  sdk: FacebookSdkState;
  onReconnected: () => void;
}) {
  const t = useTranslations();
  const pinId = useId();
  const hintId = useId();
  const [pin, setPin] = useState("");
  const pinValid = pin === "" || PIN_PATTERN.test(pin);
  // "restricted" is Meta's call to lift (WhatsApp Manager); re-running signup won't fix it.
  const canReconnect = number.connectionState !== "restricted";
  const offerPin = number.connectionState === "reconnect_required";

  return (
    <div
      role="status"
      className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="flex items-start gap-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {message}
      </p>
      {canReconnect ? (
        <div className="flex flex-wrap items-end gap-3">
          {offerPin ? (
            <div className="space-y-1">
              <Label htmlFor={pinId} className="text-xs">
                {t.channels.pinLabel}
              </Label>
              <Input
                id={pinId}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="off"
                maxLength={6}
                className="w-32 tabular-nums"
                aria-describedby={hintId}
                aria-invalid={!pinValid}
              />
            </div>
          ) : null}
          <WhatsappSignupButton
            config={config}
            sdk={sdk}
            pin={pin && pinValid ? pin : undefined}
            disabled={!pinValid}
            size="sm"
            variant="outline"
            icon="retry"
            label={t.channels.connectAgain}
            onConnected={onReconnected}
          />
          {offerPin ? (
            <p id={hintId} className="w-full text-xs text-muted-foreground">
              {pinValid ? t.channels.pinHint : t.channels.pinInvalid}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
