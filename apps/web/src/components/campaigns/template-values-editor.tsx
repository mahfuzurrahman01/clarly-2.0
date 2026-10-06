"use client";

import type { CampaignTemplateValue } from "@/lib/api/campaigns";
import type { TemplateVariable } from "@/lib/api/templates";
import { useTranslations } from "@/lib/i18n/provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fill } from "./format";

type ValueMode = "literal" | "name" | "phone";

function modeOf(value: CampaignTemplateValue): ValueMode {
  if (value.type === "literal") return "literal";
  return value.field === "name" ? "name" : "phone";
}

/** The grammar is a closed whitelist (D2): a fixed string, or the customer's name/phone with a fallback. */
export function blankValue(): CampaignTemplateValue {
  return { type: "literal", value: "" };
}

export function isValueComplete(value: CampaignTemplateValue): boolean {
  return value.type === "literal"
    ? value.value.trim().length > 0
    : value.fallback.trim().length > 0;
}

/**
 * One row per `{{n}}` in the approved body. Meta rejects an empty parameter,
 * so a customer field is never offered without a fallback — "Hi , your
 * order…" is worse than "Hi there".
 */
export function TemplateValuesEditor({
  variables,
  values,
  onChange,
  disabled,
}: {
  variables: TemplateVariable[];
  values: CampaignTemplateValue[];
  onChange: (values: CampaignTemplateValue[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();

  const MODE_LABEL: Record<ValueMode, string> = {
    literal: t.campaigns.template.valueLiteral,
    name: t.campaigns.template.valueCustomerName,
    phone: t.campaigns.template.valueCustomerPhone,
  };

  if (variables.length === 0) return null;

  function update(index: number, next: CampaignTemplateValue) {
    onChange(values.map((value, i) => (i === index ? next : value)));
  }

  function changeMode(index: number, mode: ValueMode) {
    if (mode === "literal") {
      update(index, { type: "literal", value: "" });
      return;
    }
    update(index, {
      type: "customer_field",
      field: mode === "name" ? "name" : "phone",
      fallback: "",
    });
  }

  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-medium text-foreground">
        {t.campaigns.template.valuesTitle}
      </legend>
      <p className="max-w-[65ch] text-sm text-muted-foreground">
        {t.campaigns.template.valuesHint}
      </p>

      <div className="space-y-3">
        {variables.map((variable, index) => {
          const value = values[index] ?? blankValue();
          const mode = modeOf(value);
          const modeId = `template-value-mode-${variable.position}`;
          const textId = `template-value-text-${variable.position}`;

          return (
            <div
              key={variable.position}
              className="grid gap-3 rounded-lg border border-border bg-card p-3 sm:grid-cols-[auto_minmax(0,14rem)_minmax(0,1fr)] sm:items-end"
            >
              <span className="self-center rounded bg-secondary px-2 py-1 text-xs font-medium tabular-nums text-foreground">
                {`{{${variable.position}}}`}
                {variable.label ? (
                  <span className="ms-2 font-normal text-muted-foreground">
                    {variable.label}
                  </span>
                ) : null}
              </span>

              <div className="space-y-1.5">
                <Label htmlFor={modeId} className="text-xs">
                  {t.campaigns.template.label}
                </Label>
                <Select
                  value={mode}
                  onValueChange={(next) => changeMode(index, next as ValueMode)}
                  disabled={disabled}
                >
                  <SelectTrigger id={modeId} className="w-full">
                    {/* Base UI resolves a label only for the data-driven
                        `items` API; composed children need this function. */}
                    <SelectValue>{() => MODE_LABEL[mode]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="literal">
                      {t.campaigns.template.valueLiteral}
                    </SelectItem>
                    <SelectItem value="name">
                      {t.campaigns.template.valueCustomerName}
                    </SelectItem>
                    <SelectItem value="phone">
                      {t.campaigns.template.valueCustomerPhone}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={textId} className="text-xs">
                  {value.type === "literal"
                    ? t.campaigns.template.valueTextLabel
                    : t.campaigns.template.valueFallbackLabel}
                </Label>
                <Input
                  id={textId}
                  value={
                    value.type === "literal" ? value.value : value.fallback
                  }
                  disabled={disabled}
                  maxLength={value.type === "literal" ? 1000 : 200}
                  placeholder={
                    value.type === "literal"
                      ? (variable.example ??
                        fill(t.campaigns.template.valuePlaceholder, {
                          position: String(variable.position),
                        }))
                      : t.campaigns.template.valueFallbackPlaceholder
                  }
                  onChange={(event) =>
                    update(
                      index,
                      value.type === "literal"
                        ? { type: "literal", value: event.target.value }
                        : { ...value, fallback: event.target.value },
                    )
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
