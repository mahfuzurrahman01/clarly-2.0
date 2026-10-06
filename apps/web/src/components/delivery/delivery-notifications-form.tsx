"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Loader2, MessageSquareText, Save } from "lucide-react";
import { toast } from "sonner";
import {
  NOTIFIABLE_STATUSES,
  updateDeliveryNotificationSettings,
  type DeliveryNotificationSettings,
  type NotifiableStatus,
} from "@/lib/api/delivery";
import type { MessageTemplateRecord } from "@/lib/api/templates";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LtrToken } from "./ltr-token";
import { OptInSwitch } from "./opt-in-switch";
import { formatDateTimeOr, shipmentStatusLabel } from "./format";

const UNMAPPED = "none";

/**
 * Per-tenant delivery notifications.
 *
 * This screen is an opt-in, and the default is off in three places at once:
 * the column default, the "no settings row" fallback the page passes in, and
 * this component's own starting state. Nothing infers "on" from the absence
 * of an answer — a billed, business-initiated message to a merchant's whole
 * customer base is not a thing to switch on optimistically.
 *
 * The status→template map is the second gate: an unmapped status is never
 * sent, so leaving all five unmapped is a valid, inert configuration and the
 * form says so rather than blocking the save.
 */
export function DeliveryNotificationsForm({
  initial,
  templates,
}: {
  initial: DeliveryNotificationSettings;
  templates: MessageTemplateRecord[];
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [enabled, setEnabled] = useState(initial.enabled);
  const [mapping, setMapping] = useState<
    Partial<Record<NotifiableStatus, string>>
  >(initial.statusTemplates);
  const [updatedAt, setUpdatedAt] = useState(initial.updatedAt);
  const [saving, setSaving] = useState(false);

  const mappedCount = NOTIFIABLE_STATUSES.filter(
    (status) => mapping[status],
  ).length;
  const noTemplates = templates.length === 0;

  function setTemplate(status: NotifiableStatus, templateId: string) {
    setMapping((prev) => {
      const next = { ...prev };
      if (templateId === UNMAPPED) delete next[status];
      else next[status] = templateId;
      return next;
    });
  }

  function templateName(id: string | undefined): string {
    if (!id) return t.delivery.notifications.noTemplate;
    return templates.find((item) => item.id === id)?.name ?? id;
  }

  async function save() {
    setSaving(true);
    try {
      const saved = await updateDeliveryNotificationSettings({
        enabled,
        statusTemplates: mapping,
      });
      setEnabled(saved.enabled);
      setMapping(saved.statusTemplates);
      setUpdatedAt(saved.updatedAt);
      toast.success(t.delivery.notifications.saved);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.delivery.notifications.couldNotSave),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.delivery.notifications.title}
        </h2>
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
          {t.delivery.notifications.description}
        </p>
      </header>

      <div className="space-y-5 rounded-xl border border-border bg-card/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t.delivery.notifications.toggleLabel}
            </p>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? t.delivery.notifications.stateOn
                : t.delivery.notifications.stateOff}
              <span className="mx-1.5" aria-hidden>
                ·
              </span>
              {t.delivery.notifications.updatedAt}{" "}
              {formatDateTimeOr(
                updatedAt,
                locale,
                t.delivery.notifications.neverUpdated,
              )}
            </p>
          </div>
          <OptInSwitch
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t.delivery.notifications.toggleLabel}
            describedBy="delivery-notifications-consequence"
            disabled={saving}
          />
        </div>

        <div
          id="delivery-notifications-consequence"
          className="space-y-2 rounded-lg border border-border bg-secondary/40 p-4"
        >
          <p className="text-sm font-medium">
            {t.delivery.notifications.consequenceTitle}
          </p>
          <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
            {t.delivery.notifications.consequenceBody}
          </p>
          <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
            {t.delivery.notifications.consequenceGuards}
          </p>
          {!enabled ? (
            <p className="text-xs text-muted-foreground">
              {t.delivery.notifications.defaultOffNote}
            </p>
          ) : null}
        </div>

        {enabled && mappedCount === 0 ? (
          <p
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-700 dark:text-amber-400"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t.delivery.notifications.enabledWithoutMapping}
          </p>
        ) : null}
      </div>

      <div className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {t.delivery.notifications.mappingTitle}
          </h3>
          <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
            {t.delivery.notifications.mappingHint}
          </p>
        </div>

        {noTemplates ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-5 py-6">
            <MessageSquareText
              className="size-5 text-muted-foreground"
              aria-hidden
            />
            <p className="max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              {t.delivery.notifications.noApprovedTemplates}
            </p>
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/settings/templates" />}
            >
              {t.delivery.notifications.templatesLink}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {NOTIFIABLE_STATUSES.map((status) => {
              const id = `delivery-template-${status}`;
              const value = mapping[status] ?? UNMAPPED;
              return (
                <li
                  key={status}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <Label htmlFor={id} className="text-sm">
                    {shipmentStatusLabel(t, status)}
                  </Label>
                  <Select
                    value={value}
                    onValueChange={(next) => setTemplate(status, next as string)}
                    disabled={saving}
                  >
                    <SelectTrigger id={id} className="w-64">
                      <SelectValue>
                        {() => templateName(mapping[status])}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNMAPPED}>
                        {t.delivery.notifications.noTemplate}
                      </SelectItem>
                      {templates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          <LtrToken>{template.name}</LtrToken>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Save className="size-4" aria-hidden />
          )}
          {saving
            ? t.delivery.notifications.saving
            : t.delivery.notifications.save}
        </Button>
      </div>
    </section>
  );
}
