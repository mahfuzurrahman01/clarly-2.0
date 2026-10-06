"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_CAMPAIGN_NAME_LENGTH,
  createCampaign,
  updateCampaign,
  type CampaignRecord,
  type CampaignTemplateValue,
  type SegmentRecord,
} from "@/lib/api/campaigns";
import type { MessageTemplateRecord } from "@/lib/api/templates";
import type { ConnectedWhatsappNumber } from "@/lib/api/whatsapp-connect";
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
import { fill, formatCount } from "./format";
import { TemplatePicker } from "./template-picker";
import {
  TemplateValuesEditor,
  blankValue,
  isValueComplete,
} from "./template-values-editor";
import { templateBlock } from "./template-gate";

/**
 * Authoring. Creating a campaign only ever produces a DRAFT — nothing is
 * refusable and nothing is sent here. The gates (template, spend cap,
 * eligibility) all run at schedule, on the detail screen, where their
 * answers can be shown next to the launch button.
 *
 * The template picker still enforces D2's rules at composition time, because
 * a merchant should not be able to fill in a template the send path will
 * reject three screens later.
 */
export function CampaignComposer({
  templates,
  numbers,
  segments,
  campaign,
}: {
  templates: MessageTemplateRecord[];
  numbers: ConnectedWhatsappNumber[];
  segments: SegmentRecord[];
  /** Present when editing an existing draft. */
  campaign?: CampaignRecord;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();

  const [name, setName] = useState(campaign?.name ?? "");
  const [templateId, setTemplateId] = useState<string | null>(
    campaign?.templateId ?? null,
  );
  const [values, setValues] = useState<CampaignTemplateValue[]>(
    campaign?.templateValues ?? [],
  );
  const [segmentId, setSegmentId] = useState<string | null>(
    campaign?.segmentId ?? null,
  );
  const [phoneNumberId, setPhoneNumberId] = useState<string | null>(
    campaign?.phoneNumberId ?? numbers[0]?.phoneNumberId ?? null,
  );
  const [spendCap, setSpendCap] = useState(
    campaign ? String(campaign.spendCapUsd) : "",
  );
  const [saving, setSaving] = useState(false);

  const template = templates.find((item) => item.id === templateId) ?? null;
  const variables = template?.variables ?? [];
  const valuesComplete =
    values.length === variables.length && values.every(isValueComplete);

  const ready =
    name.trim().length > 0 &&
    templateId !== null &&
    template !== null &&
    templateBlock(template, t) === null &&
    segmentId !== null &&
    phoneNumberId !== null &&
    valuesComplete;

  function chooseTemplate(next: MessageTemplateRecord) {
    setTemplateId(next.id);
    // The API requires exactly one value per placeholder, so the array is
    // resized with the template rather than carried over blindly.
    setValues(next.variables.map(() => blankValue()));
  }

  async function save() {
    if (!ready || !segmentId || !templateId || !phoneNumberId) return;
    setSaving(true);
    try {
      const cap = Number(spendCap);
      const body = {
        name: name.trim(),
        segmentId,
        templateId,
        templateValues: values,
        phoneNumberId,
        ...(spendCap.trim() && Number.isFinite(cap) && cap > 0
          ? { spendCapUsd: cap }
          : {}),
      };
      const saved = campaign
        ? await updateCampaign(campaign.id, body)
        : await createCampaign(body);
      toast.success(t.campaigns.compose.saved);
      router.push(`/campaigns/${saved.id}`);
      router.refresh();
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.campaigns.compose.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  const selectedSegment = segments.find((item) => item.id === segmentId);

  return (
    <div className="space-y-10">
      <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
        {t.campaigns.compose.subtitle}
      </p>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="campaign-name">
              {t.campaigns.compose.nameLabel}
            </Label>
            <Input
              id="campaign-name"
              value={name}
              maxLength={MAX_CAMPAIGN_NAME_LENGTH}
              placeholder={t.campaigns.compose.namePlaceholder}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {t.campaigns.compose.nameHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="campaign-number">
              {t.campaigns.compose.numberLabel}
            </Label>
            {numbers.length === 0 ? (
              <p className="text-sm text-destructive">
                {t.campaigns.compose.noNumbers}
              </p>
            ) : (
              <Select
                value={phoneNumberId ?? ""}
                onValueChange={(next) => setPhoneNumberId(next)}
              >
                <SelectTrigger id="campaign-number" className="w-full">
                  <SelectValue>
                    {() => numberLabel(numbers, phoneNumberId)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {numbers.map((number) => (
                    <SelectItem
                      key={number.phoneNumberId}
                      value={number.phoneNumberId}
                    >
                      {number.displayPhoneNumber ?? number.phoneNumberId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="max-w-[45ch] text-xs text-muted-foreground">
              {t.campaigns.compose.numberHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="campaign-segment">
              {t.campaigns.compose.segmentLabel}
            </Label>
            <Select
              value={segmentId ?? ""}
              onValueChange={(next) => setSegmentId(next)}
            >
              <SelectTrigger id="campaign-segment" className="w-full">
                <SelectValue>
                  {() =>
                    selectedSegment?.name ?? t.campaigns.compose.segmentNone
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {segments.map((segment) => (
                  <SelectItem key={segment.id} value={segment.id}>
                    {segment.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedSegment?.lastResolvedCount !== null &&
            selectedSegment?.lastResolvedCount !== undefined ? (
              <p className="text-xs tabular-nums text-muted-foreground">
                {fill(t.campaigns.segment.previewResult, {
                  count: formatCount(selectedSegment.lastResolvedCount, locale),
                })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t.campaigns.compose.segmentHint}{" "}
              <Link
                href="/campaigns/audiences"
                className="underline underline-offset-4 hover:text-foreground"
              >
                {t.campaigns.list.audiences}
              </Link>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="campaign-cap">
              {t.campaigns.compose.spendCapLabel}
            </Label>
            <Input
              id="campaign-cap"
              type="number"
              inputMode="decimal"
              min={1}
              step="any"
              className="tabular-nums"
              value={spendCap}
              onChange={(event) => setSpendCap(event.target.value)}
            />
            <p className="max-w-[45ch] text-xs text-muted-foreground">
              {t.campaigns.compose.spendCapHint}
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              {t.campaigns.template.label}
            </p>
            <p className="max-w-[65ch] text-xs text-muted-foreground">
              {t.campaigns.template.hint}
            </p>
          </div>
          <TemplatePicker
            templates={templates}
            value={templateId}
            onChange={chooseTemplate}
          />

          {template && variables.length > 0 ? (
            <TemplateValuesEditor
              variables={variables}
              values={values}
              onChange={setValues}
            />
          ) : null}

          {template && !valuesComplete ? (
            <p className="text-sm text-muted-foreground">
              {t.campaigns.template.valueMissing}
            </p>
          ) : null}
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <Button onClick={save} disabled={!ready || saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {campaign ? t.campaigns.compose.saveChanges : t.campaigns.compose.save}
        </Button>
        <Button
          variant="ghost"
          render={
            <Link href={campaign ? `/campaigns/${campaign.id}` : "/campaigns"} />
          }
        >
          {t.campaigns.compose.cancel}
        </Button>
        {!ready ? (
          <span className="text-xs text-muted-foreground">
            {t.campaigns.compose.missingFields}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function numberLabel(
  numbers: ConnectedWhatsappNumber[],
  phoneNumberId: string | null,
): string {
  const match = numbers.find((item) => item.phoneNumberId === phoneNumberId);
  if (!match) return phoneNumberId ?? "";
  return match.displayPhoneNumber ?? match.phoneNumberId;
}
