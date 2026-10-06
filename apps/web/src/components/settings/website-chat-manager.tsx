"use client";

import { useMemo, useState } from "react";
import { Copy, KeyRound, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { API_BASE_URL } from "@/lib/api/client";
import {
  embedSnippet,
  rotateWidgetKey,
  updateWidget,
  type WidgetConfig,
  type WidgetLocale,
  type WidgetPosition,
} from "@/lib/api/widget";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const POSITIONS: WidgetPosition[] = ["right", "left"];
const LOCALES: WidgetLocale[] = ["auto", "ar", "en"];

/** Mirrors the API's rule: https anywhere, plain http only on localhost. */
function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function WebsiteChatManager({
  initial,
  canEdit,
  consoleOrigin,
}: {
  initial: WidgetConfig;
  canEdit: boolean;
  consoleOrigin: string;
}) {
  const t = useTranslations();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [origins, setOrigins] = useState<string[]>(initial.allowedOrigins);
  const [draftOrigin, setDraftOrigin] = useState("");
  const [originError, setOriginError] = useState<string | null>(null);
  const [title, setTitle] = useState(initial.title ?? "");
  const [welcome, setWelcome] = useState(initial.welcomeMessage ?? "");
  const [color, setColor] = useState(initial.accentColor);
  const [position, setPosition] = useState<WidgetPosition>(initial.position);
  const [locale, setLocale] = useState<WidgetLocale>(initial.locale);
  const [saving, setSaving] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  const dirty = useMemo(
    () =>
      enabled !== saved.enabled ||
      !sameList(origins, saved.allowedOrigins) ||
      title.trim() !== (saved.title ?? "") ||
      welcome.trim() !== (saved.welcomeMessage ?? "") ||
      color.toLowerCase() !== saved.accentColor.toLowerCase() ||
      position !== saved.position ||
      locale !== saved.locale,
    [enabled, origins, title, welcome, color, position, locale, saved],
  );

  const snippet = embedSnippet(consoleOrigin, API_BASE_URL, saved.publicKey);

  function addOrigin() {
    const normalised = normaliseOrigin(draftOrigin);
    if (!normalised) {
      setOriginError(t.widget.invalidOrigin);
      return;
    }
    setOriginError(null);
    setOrigins((prev) => (prev.includes(normalised) ? prev : [...prev, normalised]));
    setDraftOrigin("");
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const next = await updateWidget({
        enabled,
        allowedOrigins: origins,
        title: title.trim() || null,
        welcomeMessage: welcome.trim() || null,
        accentColor: color,
        position,
        locale,
      });
      setSaved(next);
      setOrigins(next.allowedOrigins);
      toast.success(t.widget.saved);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.widget.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setRotating(true);
    try {
      const next = await rotateWidgetKey();
      setSaved(next);
      setConfirmRotate(false);
      toast.success(t.widget.rotated);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.widget.couldNotSave));
    } finally {
      setRotating(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success(t.widget.copied);
    } catch {
      // Clipboard blocked: the snippet is selectable in the box.
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        {!canEdit ? (
          <p className="mb-6 rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            {t.widget.adminOnly}
          </p>
        ) : null}
        <fieldset disabled={!canEdit} className="space-y-8">
          <div className="space-y-2">
            <p className="text-sm font-medium">{t.widget.statusLabel}</p>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {[true, false].map((value) => (
                <button
                  key={String(value)}
                  type="button"
                  onClick={() => setEnabled(value)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    enabled === value
                      ? value
                        ? "bg-lime-soft/70 font-medium text-foreground"
                        : "bg-secondary font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {value ? t.widget.on : t.widget.off}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t.widget.statusHint}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t.widget.originsLabel}</p>
            <p className="text-xs text-muted-foreground">{t.widget.originsHint}</p>
            {origins.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.widget.noOrigins}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {origins.map((origin) => (
                  <li key={origin} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="font-mono text-sm" dir="ltr">
                      {origin}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.widget.removeOrigin}
                      onClick={() => setOrigins((prev) => prev.filter((o) => o !== origin))}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex max-w-lg gap-2">
              <Input
                value={draftOrigin}
                placeholder={t.widget.originPlaceholder}
                onChange={(e) => setDraftOrigin(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOrigin();
                  }
                }}
                aria-invalid={originError !== null}
                className="font-mono"
                dir="ltr"
              />
              <Button type="button" variant="secondary" onClick={addOrigin} disabled={!draftOrigin.trim()}>
                <Plus className="size-4" />
                {t.widget.addOrigin}
              </Button>
            </div>
            {originError ? (
              <p role="alert" className="text-xs text-destructive">
                {originError}
              </p>
            ) : null}
          </div>

          <div className="space-y-4">
            <p className="text-sm font-medium">{t.widget.appearanceLabel}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="widget-title">{t.widget.titleLabel}</Label>
                <Input id="widget-title" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
                <p className="text-xs text-muted-foreground">{t.widget.titleHint}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="widget-color">{t.widget.colorLabel}</Label>
                <div className="flex items-center gap-2">
                  <input
                    id="widget-color"
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
                  />
                  <span className="font-mono text-sm" dir="ltr">
                    {color.toUpperCase()}
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="widget-welcome">{t.widget.welcomeLabel}</Label>
              <Input id="widget-welcome" value={welcome} maxLength={300} onChange={(e) => setWelcome(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t.widget.welcomeHint}</p>
            </div>
            <div className="flex flex-wrap gap-8">
              <div className="space-y-1.5">
                <p className="text-sm">{t.widget.positionLabel}</p>
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {POSITIONS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPosition(p)}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-sm transition-colors",
                        position === p ? "bg-lime-soft/70 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t.widget.positions[p]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-sm">{t.widget.localeLabel}</p>
                <div className="inline-flex rounded-lg border border-border p-0.5">
                  {LOCALES.map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLocale(l)}
                      className={cn(
                        "rounded-md px-3 py-1.5 text-sm transition-colors",
                        locale === l ? "bg-lime-soft/70 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t.widget.locales[l]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </fieldset>

        {canEdit ? (
          <div className="mt-6 flex items-center gap-3 border-t border-border pt-5">
            <Button onClick={save} disabled={!dirty || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t.widget.save}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="space-y-3 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <div>
          <h2 className="font-display text-lg font-medium tracking-tight">{t.widget.snippetLabel}</h2>
          <p className="text-sm text-muted-foreground">{t.widget.snippetHint}</p>
        </div>
        {!saved.enabled || saved.allowedOrigins.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
            {t.widget.enableFirst}
          </p>
        ) : null}
        <pre
          className="overflow-x-auto rounded-lg border border-border bg-secondary/60 p-3 font-mono text-xs leading-relaxed"
          dir="ltr"
        >
          {snippet}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={copy}>
            <Copy className="size-4" />
            {t.widget.copy}
          </Button>
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(true)}>
              <KeyRound className="size-4" />
              {t.widget.rotate}
            </Button>
          ) : null}
        </div>
      </section>

      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t.widget.rotate}</DialogTitle>
            <DialogDescription>{t.widget.rotateConfirm}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)} disabled={rotating}>
              {t.common.close}
            </Button>
            <Button variant="destructive" onClick={rotate} disabled={rotating}>
              {rotating ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.widget.rotate}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
