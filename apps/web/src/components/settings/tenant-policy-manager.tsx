"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { upsertTenantPolicy } from "@/lib/api/tenant-policy";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function TenantPolicyManager({
  initialStuckTicketMinutes,
  initialRerankEnabled,
}: {
  initialStuckTicketMinutes: number;
  initialRerankEnabled: boolean;
}) {
  const t = useTranslations();
  const [minutes, setMinutes] = useState(String(initialStuckTicketMinutes));
  const [rerank, setRerank] = useState(initialRerankEnabled);
  const [saving, setSaving] = useState(false);

  const dirty =
    Number(minutes) !== initialStuckTicketMinutes || rerank !== initialRerankEnabled;

  async function save() {
    const parsed = Number(minutes);
    if (!Number.isFinite(parsed) || parsed <= 0 || saving) return;
    setSaving(true);
    try {
      await upsertTenantPolicy({
        stuckTicketThresholdMinutes: parsed,
        rerankEnabled: rerank,
      });
      toast.success(t.tenantPolicy.saved, {
        description: t.tenantPolicy.savedNoAgentNote,
      });
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.tenantPolicy.couldNotSave));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="stuck-minutes">
              {t.tenantPolicy.stuckTicketLabel}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="stuck-minutes"
                type="number"
                min={1}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                className="w-28"
              />
              <span className="text-sm text-muted-foreground">
                {t.tenantPolicy.minutesSuffix}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{t.tenantPolicy.stuckTicketHint}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t.tenantPolicy.rerankLabel}</p>
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setRerank(true)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  rerank
                    ? "bg-lime-soft/70 font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.tenantPolicy.rerankOn}
              </button>
              <button
                type="button"
                onClick={() => setRerank(false)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  !rerank
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.tenantPolicy.rerankOff}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{t.tenantPolicy.rerankHint}</p>
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-border pt-5">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t.tenantPolicy.save}
          </Button>
        </div>
      </section>

      <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
        {t.tenantPolicy.otherFieldsNote}
        <Link href="/settings/agent" className="text-lime-text underline">
          {t.tenantPolicy.otherFieldsLink}
        </Link>
        {t.tenantPolicy.otherFieldsSuffix}
        <br />
        {t.tenantPolicy.publishWarning}
      </p>
    </div>
  );
}
