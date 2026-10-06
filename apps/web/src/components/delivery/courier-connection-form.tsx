"use client";

import { useState } from "react";
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  COURIER_CREDENTIAL_FIELDS,
  upsertCourierConnection,
  type Courier,
  type CourierConnection,
  type CourierConnectionResult,
} from "@/lib/api/delivery";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrToken } from "./ltr-token";
import { courierLabel, credentialHint, credentialLabel } from "./format";

/** Empty every time it mounts — there is no saved value to prefill it with. */
function blankCredentials(courier: Courier): Record<string, string> {
  return Object.fromEntries(
    COURIER_CREDENTIAL_FIELDS[courier].map((field) => [field.key, ""]),
  );
}

/**
 * Connect or re-credential one courier account.
 *
 * The single rule this form exists to enforce: **a stored credential is never
 * displayed, not even as dots or a masked tail.** The API returns none, so
 * every field starts empty on every open, and "change my password" and
 * "connect for the first time" are the same gesture — enter the whole set.
 * Nothing masked is ever posted back, because there is nothing masked to post.
 *
 * `accountRef` is the upsert key, so it is locked when re-entering an
 * existing connection: editing it would silently create a second connection
 * rather than replace the credentials on this one.
 */
export function CourierConnectionForm({
  courier,
  existing,
  onSaved,
  onCancel,
}: {
  courier: Courier;
  existing: CourierConnection | null;
  onSaved: (result: CourierConnectionResult) => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const fields = COURIER_CREDENTIAL_FIELDS[courier];

  const [accountRef, setAccountRef] = useState(existing?.accountRef ?? "");
  const [values, setValues] = useState(() => blankCredentials(courier));
  const [saving, setSaving] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const complete =
    accountRef.trim() !== "" &&
    fields.every((field) => values[field.key].trim() !== "");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!complete || saving) return;
    setSaving(true);
    setRejection(null);
    try {
      const result = await upsertCourierConnection({
        courier,
        accountRef: accountRef.trim(),
        credentials: Object.fromEntries(
          fields.map((field) => [field.key, values[field.key].trim()]),
        ),
      });
      // Clear the typed secrets the moment the request resolves, whichever
      // way it went — a rejected credential set has no business sitting in
      // component state waiting for the next render.
      setValues(blankCredentials(courier));
      if (result.verificationError) {
        setRejection(result.verificationError);
        toast.error(t.delivery.connections.savedInactive);
      } else {
        toast.success(t.delivery.connections.saved);
      }
      onSaved(result);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.delivery.connections.couldNotSave),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/50 p-3.5">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t.delivery.credentials.writeOnlyTitle}
          </p>
          <p className="max-w-[65ch] text-xs leading-relaxed text-muted-foreground">
            {t.delivery.credentials.writeOnlyBody}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`account-ref-${courier}`}>
            {t.delivery.connections.accountRefLabel}
          </Label>
          {existing ? (
            <p className="flex h-8 items-center rounded-lg border border-border bg-secondary px-2.5 text-sm">
              <LtrToken tabular>{existing.accountRef}</LtrToken>
            </p>
          ) : (
            <Input
              id={`account-ref-${courier}`}
              dir="ltr"
              value={accountRef}
              onChange={(event) => setAccountRef(event.target.value)}
              autoComplete="off"
              required
            />
          )}
          <p className="text-xs text-muted-foreground">
            {t.delivery.connections.accountRefHint}
          </p>
        </div>

        {fields.map((field) => {
          const id = `cred-${courier}-${field.key}`;
          const hint = credentialHint(t, courier, field.key);
          return (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={id}>
                {credentialLabel(t, courier, field.key)}
              </Label>
              <Input
                id={id}
                dir="ltr"
                type={field.secret ? "password" : "text"}
                value={values[field.key]}
                onChange={(event) =>
                  setValues((prev) => ({
                    ...prev,
                    [field.key]: event.target.value,
                  }))
                }
                autoComplete="off"
                spellCheck={false}
                required
              />
              {hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
              ) : null}
            </div>
          );
        })}
      </div>

      {rejection ? (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3.5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4 shrink-0" aria-hidden />
            {t.delivery.connections.rejectionTitle}
          </p>
          <p dir="ltr" className="text-start font-mono text-xs text-destructive">
            {rejection}
          </p>
          <p className="text-xs text-muted-foreground">
            {t.delivery.connections.rejectionHint}
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!complete || saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <ShieldCheck className="size-4" aria-hidden />
          )}
          {saving
            ? t.delivery.connections.saving
            : t.delivery.connections.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          {t.delivery.connections.cancel}
        </Button>
        {!complete ? (
          <p className="text-xs text-muted-foreground">
            {t.delivery.connections.requiredFields}
          </p>
        ) : null}
      </div>
      <p className="sr-only" aria-live="polite">
        {saving ? `${t.delivery.connections.saving} — ${courierLabel(courier)}` : ""}
      </p>
    </form>
  );
}
