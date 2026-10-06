"use client";

import Link from "next/link";
import { CheckCircle2, Lock } from "lucide-react";
import type { MessageTemplateRecord } from "@/lib/api/templates";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { splitTemplateBody, templateBlock } from "./template-gate";

/**
 * Templates as a radio group, not a `<select>`: the approved body, the
 * category and the reason a template cannot be broadcast are all part of the
 * decision, and none of them fit in an option row.
 *
 * Blocked templates stay visible and disabled with their reason. Hiding them
 * would leave a merchant hunting for a template they can see in Settings and
 * not here.
 */
export function TemplatePicker({
  templates,
  value,
  onChange,
  disabled,
}: {
  templates: MessageTemplateRecord[];
  value: string | null;
  onChange: (template: MessageTemplateRecord) => void;
  disabled?: boolean;
}) {
  const t = useTranslations();

  const decorated = templates
    .map((template) => ({ template, block: templateBlock(template, t) }))
    .sort((a, b) => Number(Boolean(a.block)) - Number(Boolean(b.block)));

  const sendable = decorated.filter((entry) => !entry.block).length;

  if (templates.length === 0 || sendable === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-6">
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          {t.campaigns.template.empty}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          render={<Link href="/settings/templates" />}
        >
          {t.campaigns.template.openTemplates}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={t.campaigns.template.label}
      className="divide-y divide-border overflow-hidden rounded-xl border border-border"
    >
      {decorated.map(({ template, block }) => {
        const selected = template.id === value;
        const blocked = Boolean(block);
        return (
          <div
            key={template.id}
            className={cn(
              "relative transition-colors",
              blocked ? "bg-muted/40" : selected ? "bg-lime-soft/30" : "bg-card",
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={blocked || disabled}
              onClick={() => onChange(template)}
              className={cn(
                "w-full px-4 py-3 text-start outline-none",
                "focus-visible:ring-3 focus-visible:ring-lime-ring/50",
                blocked
                  ? "cursor-not-allowed"
                  : "cursor-pointer hover:bg-secondary/60",
              )}
            >
              <span className="flex items-center gap-2">
                {blocked ? (
                  <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                ) : selected ? (
                  <CheckCircle2 className="size-3.5 shrink-0 text-lime-text" aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    className="size-3.5 shrink-0 rounded-full border border-border"
                  />
                )}
                <span
                  className={cn(
                    "font-medium",
                    blocked ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {template.name}
                </span>
                <span className="eyebrow text-muted-foreground">
                  {template.category ?? "—"} · {template.language}
                </span>
              </span>

              <span className="mt-2 block max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
                {splitTemplateBody(template.body).map((part, index) =>
                  part.placeholder === null ? (
                    <span key={index}>{part.text}</span>
                  ) : (
                    <span
                      key={index}
                      className="rounded bg-secondary px-1 font-medium text-foreground tabular-nums"
                    >
                      {part.text}
                    </span>
                  ),
                )}
              </span>
            </button>

            {block ? (
              <p
                className={cn(
                  "border-t border-border px-4 py-2 text-xs leading-relaxed",
                  block.reason === "marketing_opt_out"
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {block.reason === "marketing_opt_out" ? (
                  <span className="font-medium">
                    {t.campaigns.template.marketingOptOutTitle}.{" "}
                  </span>
                ) : null}
                {block.message}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
