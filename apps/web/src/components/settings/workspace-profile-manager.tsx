"use client";

import { useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  updateTenantProfile,
  type TenantDirectoryEntry,
  type TenantLocale,
  type TenantProfilePatch,
  type TenantVertical,
} from "@/lib/api/onboarding";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const VERTICALS: TenantVertical[] = ["commerce", "services", "hybrid"];
// `bn` is accepted by the API but the console has no Bangla dictionary yet,
// so it is shown and disabled rather than offered.
const LOCALES: TenantLocale[] = ["ar", "en", "bn"];
const SELECTABLE_LOCALES: ReadonlySet<TenantLocale> = new Set(["ar", "en"]);

/** Empty input clears the field; anything else is upper-cased like the API does. */
function normaliseCode(value: string): string | null {
  const trimmed = value.trim().toUpperCase();
  return trimmed === "" ? null : trimmed;
}

export function WorkspaceProfileManager({
  initial,
  canEdit,
}: {
  initial: TenantDirectoryEntry;
  canEdit: boolean;
}) {
  const t = useTranslations();
  const [saved, setSaved] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [vertical, setVertical] = useState<TenantVertical>(initial.vertical);
  const [country, setCountry] = useState(initial.country ?? "");
  const [currency, setCurrency] = useState(initial.currency ?? "");
  const [locale, setLocale] = useState<TenantLocale>(initial.defaultLocale);
  const [saving, setSaving] = useState(false);

  const countryCode = normaliseCode(country);
  const currencyCode = normaliseCode(currency);
  const countryInvalid = countryCode !== null && !/^[A-Z]{2}$/.test(countryCode);
  const currencyInvalid = currencyCode !== null && !/^[A-Z]{3}$/.test(currencyCode);

  const patch = useMemo(() => {
    const out: TenantProfilePatch = {};
    if (name.trim() && name.trim() !== saved.name) out.name = name.trim();
    if (vertical !== saved.vertical) out.vertical = vertical;
    if (countryCode !== saved.country) out.country = countryCode;
    if (currencyCode !== saved.currency) out.currency = currencyCode;
    if (locale !== saved.defaultLocale) out.defaultLocale = locale;
    return out;
  }, [name, vertical, countryCode, currencyCode, locale, saved]);

  const dirty = Object.keys(patch).length > 0;
  const canSave = canEdit && dirty && !saving && !countryInvalid && !currencyInvalid;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const next = await updateTenantProfile(patch);
      setSaved(next);
      setName(next.name);
      setCountry(next.country ?? "");
      setCurrency(next.currency ?? "");
      toast.success(t.workspace.saved);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.workspace.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      {!canEdit && (
        <p className="mb-6 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
          {t.workspace.adminOnly}
        </p>
      )}

      <fieldset disabled={!canEdit} className="space-y-7">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="workspace-name">
            {t.workspace.nameLabel}
          </label>
          <Input
            id="workspace-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            className="max-w-md"
          />
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">{t.workspace.verticalLabel}</p>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-3">
            {VERTICALS.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={vertical === v}
                onClick={() => setVertical(v)}
                className={cn(
                  "rounded-lg border p-3 text-start transition-colors",
                  vertical === v
                    ? "border-lime-ring bg-lime-soft/60"
                    : "border-border hover:bg-secondary",
                )}
              >
                <span className="block text-sm font-medium">{t.workspace.verticals[v]}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t.workspace.verticalDescriptions[v]}
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t.workspace.verticalHint}</p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="workspace-country">
              {t.workspace.countryLabel}
            </label>
            <Input
              id="workspace-country"
              value={country}
              maxLength={2}
              placeholder={t.workspace.notSet}
              aria-invalid={countryInvalid}
              onChange={(e) => setCountry(e.target.value)}
              className="w-28 font-mono uppercase"
              dir="ltr"
            />
            <p className={cn("text-xs", countryInvalid ? "text-destructive" : "text-muted-foreground")}>
              {countryInvalid ? t.workspace.invalidCountry : t.workspace.countryHint}
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="workspace-currency">
              {t.workspace.currencyLabel}
            </label>
            <Input
              id="workspace-currency"
              value={currency}
              maxLength={3}
              placeholder={t.workspace.notSet}
              aria-invalid={currencyInvalid}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-28 font-mono uppercase"
              dir="ltr"
            />
            <p className={cn("text-xs", currencyInvalid ? "text-destructive" : "text-muted-foreground")}>
              {currencyInvalid ? t.workspace.invalidCurrency : t.workspace.currencyHint}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">{t.workspace.localeLabel}</p>
          <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                disabled={!SELECTABLE_LOCALES.has(l)}
                onClick={() => setLocale(l)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  locale === l
                    ? "bg-lime-soft/70 font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.workspace.locales[l]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t.workspace.localeHint}</p>
        </div>
      </fieldset>

      {canEdit && (
        <div className="mt-6 flex items-center gap-3 border-t border-border pt-5">
          <Button onClick={save} disabled={!canSave}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {t.workspace.save}
          </Button>
        </div>
      )}
    </section>
  );
}
