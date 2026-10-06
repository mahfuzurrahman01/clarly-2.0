"use client";

import { useState } from "react";
import { Loader2, Plus, Rocket } from "lucide-react";
import { toast } from "sonner";
import {
  type AgentRecord,
  type WhatsappNumberOption,
  createAgent,
  publishAgent,
} from "@/lib/api/agents";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentConfigForm } from "./agent-config-form";
import { AgentKnowledge } from "./agent-knowledge";
import { AgentVersions } from "./agent-versions";

function StatusBadge({ agent }: { agent: AgentRecord }) {
  const t = useTranslations();
  if (agent.hasUnpublishedChanges) {
    return (
      <span className="rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        {t.settings.unpublishedChanges}
      </span>
    );
  }
  if (agent.status === "published") {
    return (
      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
        v{agent.publishedVersion} · {t.settings.liveSuffix}
      </span>
    );
  }
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {t.settings.draftNotPublished}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
      <h2 className="font-display text-lg font-medium tracking-tight">{title}</h2>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function CreateAgent({
  onCreated,
  compact,
}: {
  onCreated: (a: AgentRecord) => void;
  compact?: boolean;
}) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const agent = await createAgent(trimmed);
      onCreated(agent);
      setName("");
      toast.success(t.settings.createdTemplate.replace("{name}", agent.name));
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.settings.couldNotCreateAgent),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "flex items-center gap-2" : "flex max-w-sm flex-col gap-3"}>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && create()}
        placeholder={t.settings.agentNamePlaceholder}
        maxLength={80}
      />
      <Button onClick={create} disabled={busy || !name.trim()} size={compact ? "sm" : "default"}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        {t.settings.create}
      </Button>
    </div>
  );
}

export function AgentSettings({
  agents: initialAgents,
  numbers,
}: {
  agents: AgentRecord[];
  numbers: WhatsappNumberOption[];
}) {
  const t = useTranslations();
  // Archived agents aren't editable here — show the active ones.
  const [agents, setAgents] = useState<AgentRecord[]>(
    initialAgents.filter((a) => a.status !== "archived"),
  );
  const [selectedId, setSelectedId] = useState(agents[0]?.id ?? "");
  const [showCreate, setShowCreate] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  function upsert(updated: AgentRecord) {
    setAgents((prev) => {
      const exists = prev.some((a) => a.id === updated.id);
      return exists
        ? prev.map((a) => (a.id === updated.id ? updated : a))
        : [updated, ...prev];
    });
    setSelectedId(updated.id);
  }

  async function publish() {
    if (!selected || publishing) return;
    setPublishing(true);
    try {
      const updated = await publishAgent(selected.id);
      upsert(updated);
      toast.success(
        t.settings.publishedTemplate.replace("{version}", String(updated.publishedVersion)),
      );
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.settings.couldNotPublishAgent),
      );
    } finally {
      setPublishing(false);
    }
  }

  // Empty state — no agents yet.
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border bg-card/40 p-10 backdrop-blur-md">
        <h2 className="font-display text-xl font-medium tracking-tight">
          {t.settings.createFirstAgent}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t.settings.createFirstAgentBody}
        </p>
        <CreateAgent onCreated={upsert} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-3">
        {agents.length > 1 ? (
          <Select value={selectedId} onValueChange={(v) => setSelectedId(v ?? "")}>
            <SelectTrigger className="w-56">
              <SelectValue>{() => selected?.name ?? ""}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-display text-lg font-medium tracking-tight">
            {selected?.name}
          </span>
        )}
        {selected ? <StatusBadge agent={selected} /> : null}

        <div className="ms-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowCreate((s) => !s)}>
            <Plus className="size-4" />
            {t.settings.newAgent}
          </Button>
          <Button
            onClick={publish}
            disabled={!selected?.hasUnpublishedChanges || publishing}
          >
            {publishing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Rocket className="size-4" />
            )}
            {t.settings.publish}
          </Button>
        </div>
      </div>

      {showCreate ? (
        <div className="rounded-xl border border-border bg-card/60 p-4 backdrop-blur-md">
          <CreateAgent
            compact
            onCreated={(a) => {
              upsert(a);
              setShowCreate(false);
            }}
          />
        </div>
      ) : null}

      {selected ? (
        <>
          <Section
            title={t.settings.configurationTitle}
            description={t.settings.configurationDescription}
          >
            {/* key forces a fresh form when switching agents */}
            <AgentConfigForm
              key={selected.id}
              agent={selected}
              numbers={numbers}
              onSaved={upsert}
            />
          </Section>

          <Section
            title={t.settings.knowledgeScopeTitle}
            description={t.settings.knowledgeScopeDescription}
          >
            <AgentKnowledge key={selected.id} agentId={selected.id} />
          </Section>

          <Section title={t.settings.versionHistoryTitle}>
            <AgentVersions
              key={selected.id}
              agentId={selected.id}
              publishedVersion={selected.publishedVersion}
            />
          </Section>
        </>
      ) : null}
    </div>
  );
}
