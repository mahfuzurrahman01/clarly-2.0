"use client";

import { useState } from "react";
import {
  CornerDownLeft,
  Loader2,
  Play,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  type AgentSummary,
  type SandboxResult,
  sandboxTest,
} from "@/lib/api/agents";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import {
  escalationLabel,
  isDeterministicEscalation,
} from "@/lib/tickets/escalation";
import { confidencePct } from "@/lib/tickets/format";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type { Locale } from "@/lib/i18n/locale";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function reasonLabel(
  reason: string | null,
  t: Dictionary,
  locale: Locale,
): string {
  if (!reason) return t.playground.wouldHandOffToHuman;
  return escalationLabel(reason, locale);
}

/** Which config the picker will test — draft when there is one. */
function agentHint(a: AgentSummary, t: Dictionary): string {
  if (a.hasUnpublishedChanges) return t.playground.unpublishedDraft;
  if (a.publishedVersion !== null)
    return t.playground.liveTemplate.replace(
      "{version}",
      String(a.publishedVersion),
    );
  return t.playground.notPublishedYet;
}

export function Playground({ agents }: { agents: AgentSummary[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const STARTERS = [
    t.playground.starter1,
    t.playground.starter2,
    t.playground.starter3,
  ];
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = agents.find((a) => a.id === agentId);

  async function run() {
    const body = message.trim();
    if (!body || !agentId || running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await sandboxTest(agentId, body);
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(
        err instanceof ApiError && err.status === 403
          ? t.playground.adminsOnlyError
          : apiErrorMessage(err, t, t.playground.sandboxDidntRespond),
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {/* Ask */}
      <div className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="playground-agent"
            className="eyebrow block text-muted-foreground"
          >
            {t.playground.agent}
          </label>
          <Select
            value={agentId}
            onValueChange={(v) => setAgentId(v ?? "")}
            disabled={running}
          >
            <SelectTrigger id="playground-agent" className="w-full">
              <SelectValue placeholder={t.playground.chooseAgent}>
                {() =>
                  selected ? `${selected.name} · ${agentHint(selected, t)}` : ""
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name} · {agentHint(a, t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected?.hasUnpublishedChanges ? (
            <p className="text-xs text-muted-foreground">
              {t.playground.testingDraft}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="playground-message"
            className="eyebrow block text-muted-foreground"
          >
            {t.playground.messageAsCustomer}
          </label>
          <textarea
            id="playground-message"
            dir="auto"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                run();
              }
            }}
            rows={4}
            placeholder={t.playground.messagePlaceholder}
            className="w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40"
          />
          <div className="flex flex-wrap items-center gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setMessage(s)}
                disabled={running}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-lime-ring/70 hover:bg-lime-soft/50 hover:text-foreground disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <Button onClick={run} disabled={running || !message.trim() || !agentId}>
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4 fill-current" />
          )}
          {t.playground.run}
          <kbd className="ms-1 hidden items-center gap-0.5 rounded border border-lime-foreground/30 px-1 text-[0.625rem] sm:inline-flex">
            <CornerDownLeft className="size-3" />
          </kbd>
        </Button>
      </div>

      {/* Answer */}
      <div className="min-h-[16rem]">
        {error ? (
          <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : result ? (
          <ResultCard result={result} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 p-8 text-center backdrop-blur-md">
            <Sparkles className="size-5 text-muted-foreground/60" />
            <p className="mt-3 text-sm text-muted-foreground">
              {t.playground.emptyStateBody}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: SandboxResult }) {
  const t = useTranslations();
  const locale = useLocale();
  const sources = result.citedChunkIds.length;
  // A rule decided this handoff (customer asked for a person, a guardrail
  // fired): the model's confidence and its sources say nothing about it.
  const ruleDecided =
    result.escalate && isDeterministicEscalation(result.escalationReason);
  return (
    <div className="space-y-4 rounded-xl border border-border bg-card/60 p-5 shadow-sm backdrop-blur-md">
      {/* Answer */}
      <p
        dir="auto"
        className="text-start text-sm leading-relaxed whitespace-pre-wrap [unicode-bidi:plaintext]"
      >
        {result.answer}
      </p>

      {/* Would-escalate verdict */}
      {result.escalate ? (
        <div className="flex items-center gap-2 rounded-lg border border-lime-ring/40 bg-lime-soft/60 px-3 py-2 text-sm">
          <TriangleAlert
            className="size-4 shrink-0 text-lime-text"
            aria-hidden="true"
          />
          <span className="font-medium">{t.playground.wouldHandOff}</span>
          <span className="text-muted-foreground">
            · {reasonLabel(result.escalationReason, t, locale)}
          </span>
        </div>
      ) : null}

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {ruleDecided ? null : (
          <Badge className="border-lime-ring/40 bg-lime-soft/70 text-lime-text">
            {confidencePct(result.confidence) ?? "—"}{" "}
            {t.playground.confidenceSuffix}
          </Badge>
        )}
        <Badge
          variant={result.testedVersion === "draft" ? "outline" : "secondary"}
        >
          {result.testedVersion === "draft"
            ? t.playground.versionDraft
            : t.playground.versionPublished}
        </Badge>
        <Badge variant="secondary" className="tabular-nums">
          {t.playground.latencyTemplate.replace(
            "{ms}",
            String(result.latencyMs),
          )}
        </Badge>
      </div>

      {/* Sources — ids only until a source-title resolver endpoint exists.
          Skipped for a rule-decided handoff that cited nothing: "no sources"
          is only a finding when the model was trying to answer. */}
      {ruleDecided && sources === 0 ? null : (
        <div className="space-y-2">
          <p className="eyebrow text-muted-foreground">
            {t.playground.knowledgeBaseSources}
          </p>
          {sources === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.playground.noSourcesUsed}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {result.citedChunkIds.map((id) => (
                <code
                  key={id}
                  className={cn(
                    "rounded bg-secondary px-1.5 py-0.5 font-mono",
                    "text-[0.6875rem] text-muted-foreground",
                  )}
                >
                  {id.slice(0, 8)}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
