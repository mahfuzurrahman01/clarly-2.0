"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { type AgentVersionSummary, listVersions } from "@/lib/api/agents";
import { relativeAgo } from "@/lib/i18n/relative-time";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";

export function AgentVersions({
  agentId,
  publishedVersion,
}: {
  agentId: string;
  publishedVersion: number | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [versions, setVersions] = useState<AgentVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listVersions(agentId)
      .then((v) => {
        if (alive) setVersions(v);
      })
      .catch((err) => {
        if (alive)
          setError(apiErrorMessage(err, t, t.settings.couldNotLoadHistory));
      });
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!versions) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t.settings.loadingHistory}
      </div>
    );
  }
  if (versions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t.settings.noPublishedVersions}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
      {versions.map((v) => (
        <li key={v.version} className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium tabular-nums">v{v.version}</span>
            {v.version === publishedVersion ? (
              <span className="rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
                {t.settings.live}
              </span>
            ) : null}
          </div>
          <span className="text-xs text-muted-foreground">
            {v.publishedAt
              ? t.settings.publishedTemplateShort.replace("{age}", relativeAgo(v.publishedAt, locale))
              : t.settings.createdTemplateShort.replace("{age}", relativeAgo(v.createdAt, locale))}
          </span>
        </li>
      ))}
    </ul>
  );
}
