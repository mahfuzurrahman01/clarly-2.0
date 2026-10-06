"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Save } from "lucide-react";
import {
  type KnowledgeScopeDocument,
  getKnowledgeScope,
  setKnowledgeScope,
} from "@/lib/api/agents";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function AgentKnowledge({ agentId }: { agentId: string }) {
  const t = useTranslations();
  const [docs, setDocs] = useState<KnowledgeScopeDocument[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getKnowledgeScope(agentId)
      .then((scope) => {
        if (alive) setDocs(scope.documents);
      })
      .catch((err) => {
        if (alive)
          setError(apiErrorMessage(err, t, t.settings.couldNotLoadScope));
      });
    return () => {
      alive = false;
    };
  }, [agentId]);

  function toggle(id: string) {
    setDocs((prev) =>
      prev
        ? prev.map((d) => (d.id === id ? { ...d, selected: !d.selected } : d))
        : prev,
    );
  }

  async function save() {
    if (!docs || saving) return;
    setSaving(true);
    try {
      const ids = docs.filter((d) => d.selected).map((d) => d.id);
      await setKnowledgeScope(agentId, ids);
      toast.success(
        ids.length === 0
          ? t.settings.scopeSavedWhole
          : t.settings.scopeSavedTemplate.replace("{count}", String(ids.length)),
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.settings.couldNotSaveScope));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!docs) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t.settings.loadingScope}
      </div>
    );
  }
  if (docs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t.settings.noDocumentsYet}{" "}
        <Link href="/settings/knowledge" className="text-lime-text underline">
          {t.settings.uploadSome}
        </Link>{" "}
        {t.settings.firstThenChoose}
      </p>
    );
  }

  const noneSelected = docs.every((d) => !d.selected);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t.settings.chooseDocuments}{" "}
        {noneSelected ? (
          <span className="text-lime-text">
            {t.settings.noneSelectedHint}
          </span>
        ) : null}
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {docs.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => toggle(d.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-lime-soft/30"
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md border",
                  d.selected
                    ? "border-lime-ring bg-lime text-lime-foreground"
                    : "border-border",
                )}
              >
                {d.selected ? <Check className="size-3.5" /> : null}
              </span>
              <span className="truncate text-sm">{d.filename}</span>
            </button>
          </li>
        ))}
      </ul>
      <Button onClick={save} disabled={saving} variant="outline" size="sm">
        {saving ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Save className="size-4" />
        )}
        {t.settings.saveScope}
      </Button>
    </div>
  );
}
