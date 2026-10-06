"use client";

import { useState } from "react";
import { Check, Loader2, Lock, X } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_APPROVAL_WINDOW_HOURS,
  MIN_APPROVAL_WINDOW_HOURS,
  ORDER_MODES,
  isEligibilityError,
  getOrderSettings,
  updateOrderSettings,
  type CriterionEvidence,
  type FailedCriterion,
  type OrderMode,
  type OrderSettings,
} from "@/lib/api/orders";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { criterionEvidence, criterionLabel, fill, formatDateTime } from "./format";

/**
 * `tenant_order_settings` — the switch that decides whether a language model
 * can commit a merchant to a sale, and under what supervision.
 *
 * Two rules drive the whole component:
 *
 *  - **A blocked control has to say why it is blocked.** Auto mode is gated on
 *    five D1.5 criteria; the API sends per-criterion evidence and the panel
 *    renders all five, passed and failed, always. "Auto (unavailable)" with no
 *    explanation would leave a merchant with nothing to act on.
 *  - **The panel exists even when you can't use it.** `/orders/settings` is
 *    admin-only and 403s an agent token. Hiding it would make the feature look
 *    missing; instead an agent sees the panel, learns what it does, and is told
 *    to ask an admin.
 */
export function OrderSettingsPanel({
  initial,
  canManage,
  initialError,
  onChanged,
}: {
  /** `null` when the settings couldn't be read (agent role, or a failed fetch). */
  initial: OrderSettings | null;
  /** The signed-in user has the admin role. */
  canManage: boolean;
  initialError: string | null;
  /** Lets the queue react to a mode or approval-window change without a reload. */
  onChanged: (settings: OrderSettings) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [settings, setSettings] = useState(initial);
  const [mode, setMode] = useState<OrderMode>(initial?.mode ?? "disabled");
  const [codEnabled, setCodEnabled] = useState(initial?.codEnabled ?? true);
  const [windowHours, setWindowHours] = useState(
    String(initial?.approvalWindowHours ?? 24),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [refusal, setRefusal] = useState<FailedCriterion[] | null>(null);

  const eligibility = settings?.autoEligibility ?? null;
  const eligible = eligibility?.eligible ?? false;

  function apply(next: OrderSettings) {
    setSettings(next);
    setMode(next.mode);
    setCodEnabled(next.codEnabled);
    setWindowHours(String(next.approvalWindowHours));
    onChanged(next);
  }

  async function save() {
    const hours = Number(windowHours);
    if (
      !Number.isInteger(hours) ||
      hours < MIN_APPROVAL_WINDOW_HOURS ||
      hours > MAX_APPROVAL_WINDOW_HOURS
    ) {
      setError(t.orders.settings.windowInvalid);
      return;
    }
    setSaving(true);
    setError(null);
    setRefusal(null);
    try {
      apply(
        await updateOrderSettings({
          mode,
          codEnabled,
          approvalWindowHours: hours,
        }),
      );
      toast.success(t.orders.settings.saved);
    } catch (err) {
      if (isEligibilityError(err)) {
        // The gate was re-evaluated server-side at the moment of the call and
        // said no. Show its per-criterion reasons, and refresh the snapshot so
        // the checklist below stops disagreeing with the refusal.
        setRefusal(err.failedCriteria);
        setMode(settings?.mode ?? "disabled");
        try {
          apply(await getOrderSettings());
        } catch {
          // Keep the refusal on screen; a stale checklist is still useful.
        }
        return;
      }
      setError(apiErrorMessage(err, t, t.orders.settings.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  const modeLabels: Record<OrderMode, string> = {
    disabled: t.orders.settings.modeDisabled,
    human_approval: t.orders.settings.modeHumanApproval,
    auto: t.orders.settings.modeAuto,
  };
  const modeHints: Record<OrderMode, string> = {
    disabled: t.orders.settings.modeDisabledHint,
    human_approval: t.orders.settings.modeHumanApprovalHint,
    auto: t.orders.settings.modeAutoHint,
  };

  const dirty =
    settings !== null &&
    (mode !== settings.mode ||
      codEnabled !== settings.codEnabled ||
      windowHours !== String(settings.approvalWindowHours));

  return (
    <section
      aria-labelledby="order-settings-heading"
      className="rounded-xl border border-border p-6"
    >
      <div className="max-w-prose space-y-1.5">
        <h2
          id="order-settings-heading"
          className="font-display text-lg font-medium tracking-tight"
        >
          {t.orders.settings.title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.orders.settings.description}
        </p>
      </div>

      {!canManage ? (
        <div className="mt-5 flex items-start gap-3 rounded-lg border border-dashed border-border px-4 py-3">
          <Lock
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t.orders.settings.adminOnlyTitle}
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">
              {t.orders.settings.adminOnlyBody}
            </p>
          </div>
        </div>
      ) : settings === null ? (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error ?? t.orders.settings.couldNotLoad}
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="order-mode">{t.orders.settings.modeLabel}</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as OrderMode)}
              >
                <SelectTrigger id="order-mode" className="w-full">
                  <SelectValue>{() => modeLabels[mode]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ORDER_MODES.map((value) => (
                    <SelectItem
                      key={value}
                      value={value}
                      // Auto is the one option the API can refuse. Disabling it
                      // is safe only because the reason sits directly below.
                      disabled={value === "auto" && !eligible}
                    >
                      {modeLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="max-w-prose text-xs text-muted-foreground">
                {modeHints[mode]}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="order-window">
                {t.orders.settings.windowLabel}
              </Label>
              <Input
                id="order-window"
                type="number"
                inputMode="numeric"
                min={MIN_APPROVAL_WINDOW_HOURS}
                max={MAX_APPROVAL_WINDOW_HOURS}
                step={1}
                value={windowHours}
                onChange={(e) => setWindowHours(e.target.value)}
                className="w-32 tabular-nums"
                aria-describedby="order-window-hint"
              />
              <p
                id="order-window-hint"
                className="max-w-prose text-xs text-muted-foreground"
              >
                {t.orders.settings.windowHint}
              </p>
            </div>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">
                {t.orders.settings.codLabel}
              </span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-lime"
                  checked={codEnabled}
                  onChange={(e) => setCodEnabled(e.target.checked)}
                />
                {codEnabled
                  ? t.orders.settings.codOn
                  : t.orders.settings.codOff}
              </label>
              <p className="max-w-prose text-xs text-muted-foreground">
                {t.orders.settings.codHint}
              </p>
            </div>

            {settings.autoEnabledAt ? (
              <p className="self-end text-xs text-muted-foreground">
                {fill(t.orders.settings.autoEnabledTemplate, {
                  date: formatDateTime(settings.autoEnabledAt, locale),
                })}
              </p>
            ) : null}
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          {refusal ? (
            <div
              role="alert"
              className="mt-4 space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
            >
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                {t.orders.settings.refusedTitle}
              </p>
              <ul className="space-y-1">
                {refusal.map((item) => (
                  <li key={item.criterion} className="text-sm">
                    <span className="font-medium">
                      {criterionLabel(item.criterion, t)}
                    </span>
                    <span className="text-muted-foreground">
                      {" — "}
                      <bdi>{criterionEvidence(item.criterion, item, t, locale)}</bdi>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-5">
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.orders.settings.save}
            </Button>
          </div>

          {eligibility ? (
            <EligibilityChecklist
              eligible={eligibility.eligible}
              measuredAt={eligibility.measuredAt}
              criteria={eligibility.criteria}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * All five D1.5 criteria, passed and failed, with the API's own evidence
 * sentence under each. Failed ones are listed first: they are the work.
 */
function EligibilityChecklist({
  eligible,
  measuredAt,
  criteria,
}: {
  eligible: boolean;
  measuredAt: string;
  criteria: Array<CriterionEvidence & { key: string; met: boolean; detail: string }>;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const ordered = [
    ...criteria.filter((item) => !item.met),
    ...criteria.filter((item) => item.met),
  ];

  return (
    <div className="mt-8 border-t border-border pt-6">
      <div className="max-w-prose space-y-1.5">
        <h3 className="font-display text-base font-medium tracking-tight">
          {eligible
            ? t.orders.settings.eligibleTitle
            : t.orders.settings.eligibilityTitle}
        </h3>
        <p className="text-sm text-muted-foreground">
          {eligible
            ? t.orders.settings.eligibleBody
            : t.orders.settings.eligibilityBody}
        </p>
        {!eligible ? (
          <p className="text-sm font-medium">
            {t.orders.settings.blockedTitle}
          </p>
        ) : null}
      </div>

      <ul className="mt-4 space-y-3">
        {ordered.map((item) => (
          <li key={item.key} className="flex items-start gap-2.5">
            {item.met ? (
              <Check
                className="mt-0.5 size-4 shrink-0 text-lime-text"
                aria-hidden="true"
              />
            ) : (
              <X
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <div className="space-y-0.5">
              <p className="text-sm">
                {criterionLabel(item.key, t)}
                <span className="sr-only">
                  {" — "}
                  {item.met ? t.orders.settings.met : t.orders.settings.notMet}
                </span>
              </p>
              <p
                dir="auto"
                className="max-w-prose text-start text-xs text-muted-foreground"
              >
                {criterionEvidence(item.key, item, t, locale)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-4 max-w-prose text-xs text-muted-foreground">
        {fill(t.orders.settings.measuredTemplate, {
          date: formatDateTime(measuredAt, locale),
        })}
        {" · "}
        {t.orders.settings.noDemotionNote}
      </p>
    </div>
  );
}
