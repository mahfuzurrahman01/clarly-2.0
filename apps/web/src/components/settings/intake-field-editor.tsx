"use client";

import { useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import type {
  IntakeField,
  IntakeFieldType,
  IntakeScope,
} from "@/lib/api/agents";
import { INTAKE_FIELD_TYPES } from "@/lib/api/agents";
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
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

function fieldTypeLabels(t: Dictionary): Record<IntakeFieldType, string> {
  return {
    text: t.settings.fieldTypeText,
    number: t.settings.fieldTypeNumber,
    email: t.settings.fieldTypeEmail,
    date: t.settings.fieldTypeDate,
    choice: t.settings.fieldTypeChoice,
  };
}

/** Mirrors MAX_INTAKE_FIELDS in apps/api — over this the PATCH is rejected. */
const MAX_FIELDS = 8;
/** Mirrors the per-field `choices` cap in the API's intake field schema. */
const MAX_CHOICES = 12;

function scopeLabels(t: Dictionary): Record<IntakeScope, string> {
  return {
    conversation: t.settings.scopeConversation,
    customer: t.settings.scopeCustomer,
  };
}

type IntakeFieldEditorProps = {
  value: IntakeField[];
  onChange: (value: IntakeField[]) => void;
  className?: string;
};

let nextId = 0;
function makeKey(): string {
  return `field_${Date.now()}_${nextId++}`;
}

/**
 * Keys are used verbatim as tool-argument names, so the API enforces
 * `^[a-z][a-z0-9_]*$` (max 40). Shape the input as it is typed rather than
 * letting a leading digit or underscore reach the PATCH and 400.
 */
function sanitizeKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 40);
}

export function IntakeFieldEditor({
  value,
  onChange,
  className,
}: IntakeFieldEditorProps) {
  const t = useTranslations();
  const typeLabels = fieldTypeLabels(t);
  const scopes = scopeLabels(t);
  const [fields, setFields] = useState<IntakeField[]>(value);

  function update(index: number, patch: Partial<IntakeField>) {
    const next = [...fields];
    next[index] = { ...next[index], ...patch };
    setFields(next);
    onChange(next);
  }

  function addField() {
    const key = makeKey();
    const next = [
      ...fields,
      {
        key,
        label: "",
        type: "text" as const,
        required: false,
        scope: "conversation" as const,
      },
    ];
    setFields(next);
    onChange(next);
  }

  function removeField(index: number) {
    const next = fields.filter((_, i) => i !== index);
    setFields(next);
    onChange(next);
  }

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t.settings.intakeFieldsTitle}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addField}
          disabled={fields.length >= MAX_FIELDS}
        >
          <Plus className="size-3.5" />
          {t.settings.addField}
        </Button>
      </div>

      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          {t.settings.noIntakeFields}
        </p>
      ) : (
        <div className="space-y-3">
          {fields.map((field, i) => {
            const idBase = `intake-field-${i}`;
            return (
              <div
                key={field.key}
                className="rounded-lg border border-border p-3 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <GripVertical
                    className="size-4 text-muted-foreground shrink-0"
                    aria-hidden="true"
                  />
                  <span
                    dir="ltr"
                    className="text-xs text-muted-foreground font-mono"
                  >
                    {field.key}
                  </span>
                  <div className="flex-1" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeField(i)}
                    className="text-destructive hover:text-destructive"
                    aria-label={t.settings.removeFieldAriaTemplate.replace(
                      "{name}",
                      field.label.trim() || field.key,
                    )}
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${idBase}-label`} className="text-xs">
                      {t.settings.intakeLabel}
                    </Label>
                    <Input
                      id={`${idBase}-label`}
                      dir="auto"
                      value={field.label}
                      onChange={(e) => update(i, { label: e.target.value })}
                      placeholder={t.settings.intakeLabelPlaceholder}
                      maxLength={80}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${idBase}-key`} className="text-xs">
                      {t.settings.intakeKey}
                    </Label>
                    <Input
                      id={`${idBase}-key`}
                      dir="ltr"
                      value={field.key}
                      onChange={(e) =>
                        update(i, { key: sanitizeKey(e.target.value) })
                      }
                      placeholder="order_number"
                      className="font-mono text-xs"
                      maxLength={40}
                    />
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor={`${idBase}-type`} className="text-xs">
                      {t.settings.intakeType}
                    </Label>
                    <Select
                      value={field.type}
                      onValueChange={(v) => {
                        const patch: Partial<IntakeField> = {
                          type: v as IntakeFieldType,
                        };
                        if (
                          v === "choice" &&
                          (!field.choices || field.choices.length === 0)
                        ) {
                          patch.choices = [t.settings.intakeDefaultChoice];
                        }
                        update(i, patch);
                      }}
                    >
                      <SelectTrigger id={`${idBase}-type`} className="w-full">
                        <SelectValue>
                          {() => typeLabels[field.type]}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {INTAKE_FIELD_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {typeLabels[type]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={`${idBase}-scope`} className="text-xs">
                      {t.settings.intakeScope}
                    </Label>
                    <Select
                      value={field.scope}
                      onValueChange={(v) =>
                        update(i, { scope: v as IntakeScope })
                      }
                    >
                      <SelectTrigger id={`${idBase}-scope`} className="w-full">
                        <SelectValue>{() => scopes[field.scope]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(["conversation", "customer"] as const).map(
                          (scope) => (
                            <SelectItem key={scope} value={scope}>
                              {scopes[scope]}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <p
                      id={`${idBase}-required`}
                      className="text-xs font-medium"
                    >
                      {t.settings.intakeRequired}
                    </p>
                    <button
                      type="button"
                      onClick={() => update(i, { required: !field.required })}
                      aria-pressed={field.required}
                      aria-describedby={`${idBase}-required`}
                      className={cn(
                        "mt-1 w-full rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                        field.required
                          ? "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {field.required
                        ? t.settings.intakeRequiredOn
                        : t.settings.intakeRequiredOff}
                    </button>
                  </div>
                </div>

                {field.type === "choice" && (
                  <div className="space-y-1">
                    <Label htmlFor={`${idBase}-choices`} className="text-xs">
                      {t.settings.intakeChoices}
                    </Label>
                    <textarea
                      id={`${idBase}-choices`}
                      dir="auto"
                      value={(field.choices ?? []).join("\n")}
                      onChange={(e) =>
                        update(i, {
                          choices: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .slice(0, MAX_CHOICES),
                        })
                      }
                      rows={3}
                      className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-xs outline-none focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40"
                      placeholder={t.settings.intakeChoicePlaceholder}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t.settings.intakeLimitTemplate.replace("{max}", String(MAX_FIELDS))}
      </p>
    </div>
  );
}
