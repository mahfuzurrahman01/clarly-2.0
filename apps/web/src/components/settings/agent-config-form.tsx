"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Cable, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  AGENT_TONES,
  ESCALATION_TRIGGERS,
  type AgentConfigInput,
  type AgentRecord,
  type AgentTone,
  type OptionalEscalationTrigger,
  type WhatsappNumberOption,
  updateAgent,
} from "@/lib/api/agents";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { escalationTriggerLabel } from "@/lib/tickets/escalation";
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
import { cn } from "@/lib/utils";
import { BusinessHoursEditor } from "./business-hours-editor";
import { IntakeFieldEditor } from "./intake-field-editor";

const NONE = "__none__";

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const textarea =
  "w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

export function AgentConfigForm({
  agent,
  numbers,
  onSaved,
}: {
  agent: AgentRecord;
  numbers: WhatsappNumberOption[];
  onSaved: (updated: AgentRecord) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const TONE_LABELS: Record<AgentTone, string> = {
    formal: t.settings.toneFormal,
    friendly: t.settings.toneFriendly,
    concise: t.settings.toneConcise,
    warm: t.settings.toneWarm,
  };
  const c = agent.config;
  const [name, setName] = useState(agent.name);
  const [roleDescription, setRole] = useState(c?.roleDescription ?? "");
  const [persona, setPersona] = useState(c?.persona ?? "");
  const [tone, setTone] = useState<AgentTone | null>(c?.tone ?? null);
  const [greeting, setGreeting] = useState(c?.greeting ?? "");
  const [outOfScope, setOutOfScope] = useState(c?.outOfScopeResponse ?? "");
  const [languages, setLanguages] = useState((c?.languages ?? []).join(", "));
  const [forbidden, setForbidden] = useState((c?.forbiddenTopics ?? []).join(", "));
  const [triggers, setTriggers] = useState<OptionalEscalationTrigger[]>(
    c?.escalationTriggers ?? [],
  );
  const [confidence, setConfidence] = useState(c?.confidenceThreshold ?? 0.5);
  const [numberId, setNumberId] = useState<string | null>(agent.whatsappNumberId);
  const [businessHours, setBusinessHours] = useState(c?.businessHours ?? null);
  const [timezone, setTimezone] = useState(c?.timezone ?? "");
  const [outOfHoursResponse, setOutOfHoursResponse] = useState(c?.outOfHoursResponse ?? "");
  const [intakeFields, setIntakeFields] = useState(c?.intakeFields ?? []);
  const [saving, setSaving] = useState(false);

  // Snapshot for dirty-tracking — cheap deep compare via JSON.
  const snapshot = useMemo(
    () =>
      JSON.stringify({
        name,
        roleDescription,
        persona,
        tone,
        greeting,
        outOfScope,
        languages,
        forbidden,
        triggers: [...triggers].sort(),
        confidence,
        numberId,
        businessHours,
        timezone,
        outOfHoursResponse,
        intakeFields: JSON.stringify(intakeFields),
      }),
    [name, roleDescription, persona, tone, greeting, outOfScope, languages, forbidden, triggers, confidence, numberId, businessHours, timezone, outOfHoursResponse, intakeFields],
  );
  const initial = useMemo(
    () =>
      JSON.stringify({
        name: agent.name,
        roleDescription: c?.roleDescription ?? "",
        persona: c?.persona ?? "",
        tone: c?.tone ?? null,
        greeting: c?.greeting ?? "",
        outOfScope: c?.outOfScopeResponse ?? "",
        languages: (c?.languages ?? []).join(", "),
        forbidden: (c?.forbiddenTopics ?? []).join(", "),
        triggers: [...(c?.escalationTriggers ?? [])].sort(),
        confidence: c?.confidenceThreshold ?? 0.5,
        numberId: agent.whatsappNumberId,
        businessHours: c?.businessHours ?? null,
        timezone: c?.timezone ?? "",
        outOfHoursResponse: c?.outOfHoursResponse ?? "",
        intakeFields: JSON.stringify(c?.intakeFields ?? []),
      }),
    [agent, c],
  );
  const dirty = snapshot !== initial;

  function toggleTrigger(t: OptionalEscalationTrigger) {
    setTriggers((prev) =>
      prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t],
    );
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      // Round-trip the whole config so untouched fields (business hours, intake
      // fields, advanced numeric settings) are preserved — a PATCH replaces it.
      const config: AgentConfigInput = {
        ...(agent.config ?? {}),
        roleDescription: roleDescription.trim() || null,
        persona: persona.trim() || null,
        tone,
        greeting: greeting.trim() || null,
        outOfScopeResponse: outOfScope.trim() || null,
        languages: list(languages),
        forbiddenTopics: list(forbidden),
        escalationTriggers: triggers,
        confidenceThreshold: confidence,
        businessHours,
        timezone: timezone.trim() || null,
        outOfHoursResponse: outOfHoursResponse.trim() || null,
        intakeFields,
      };
      const updated = await updateAgent(agent.id, {
        name: name.trim(),
        config,
        whatsappNumberId: numberId,
      });
      onSaved(updated);
      toast.success(t.settings.draftSaved, {
        description: t.settings.publishToMakeLive,
      });
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t.settings.numberAlreadyBound
          : apiErrorMessage(err, t, t.settings.couldNotSaveChanges),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Identity */}
      <section className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-name">{t.settings.nameLabel}</Label>
          <Input
            id="agent-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-role">{t.settings.whatItHandles}</Label>
          <textarea
            id="agent-role"
            value={roleDescription}
            onChange={(e) => setRole(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder={t.settings.whatItHandlesPlaceholder}
            dir="auto"
            className={textarea}
          />
        </div>
      </section>

      {/* Voice */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{t.settings.voice}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="agent-tone">{t.settings.tone}</Label>
            <Select
              value={tone ?? NONE}
              onValueChange={(v) => setTone(v === NONE ? null : (v as AgentTone))}
            >
              <SelectTrigger id="agent-tone" className="w-full">
                <SelectValue placeholder={t.settings.platformDefault}>
                  {() => (tone ? TONE_LABELS[tone] : t.settings.platformDefault)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t.settings.platformDefault}</SelectItem>
                {AGENT_TONES.map((toneOption) => (
                  <SelectItem key={toneOption} value={toneOption}>
                    {TONE_LABELS[toneOption]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-langs">{t.settings.languages}</Label>
            <Input
              id="agent-langs"
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
              placeholder={t.settings.languagesPlaceholder}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-persona">{t.settings.persona}</Label>
          <textarea
            id="agent-persona"
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t.settings.personaPlaceholder}
            dir="auto"
            className={textarea}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-greeting">{t.settings.greeting}</Label>
          <textarea
            id="agent-greeting"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={2}
            maxLength={200}
            dir="auto"
            className={textarea}
          />
        </div>
      </section>

      {/* Boundaries */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{t.settings.boundaries}</h3>
        <div className="space-y-2">
          <Label htmlFor="agent-oos">{t.settings.whenItDoesntKnow}</Label>
          <textarea
            id="agent-oos"
            value={outOfScope}
            onChange={(e) => setOutOfScope(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder={t.settings.whenItDoesntKnowPlaceholder}
            dir="auto"
            className={textarea}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-forbidden">{t.settings.forbiddenTopics}</Label>
          <Input
            id="agent-forbidden"
            value={forbidden}
            onChange={(e) => setForbidden(e.target.value)}
            placeholder={t.settings.forbiddenTopicsPlaceholder}
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.forbiddenTopicsHint}
          </p>
        </div>
        <div className="space-y-2">
          <p id="agent-triggers-label" className="text-sm font-medium">
            {t.settings.alsoEscalateOn}
          </p>
          <div
            role="group"
            aria-labelledby="agent-triggers-label"
            className="flex flex-wrap gap-2"
          >
            {ESCALATION_TRIGGERS.map((trigger) => {
              const on = triggers.includes(trigger);
              return (
                <button
                  key={trigger}
                  type="button"
                  onClick={() => toggleTrigger(trigger)}
                  aria-pressed={on}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs transition-colors",
                    on
                      ? "border-lime-ring/60 bg-lime-soft/70 text-lime-text"
                      : "border-border text-muted-foreground hover:border-lime-ring/50 hover:text-foreground",
                  )}
                >
                  {escalationTriggerLabel(trigger, locale)}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {t.settings.escalateHint}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-confidence">
            {t.settings.confidenceThreshold} ·{" "}
            <span className="tabular-nums text-lime-text">
              {confidence.toFixed(2)}
            </span>
          </Label>
          <input
            id="agent-confidence"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
            className="w-full accent-lime"
          />
          <p className="text-xs text-muted-foreground">
            {t.settings.confidenceHint}
          </p>
        </div>
      </section>

      {/* Business Hours */}
      <section className="space-y-4">
        <h3 className="text-sm font-medium">{t.settings.businessHoursTitle}</h3>
        <div className="space-y-2">
          <Label htmlFor="agent-timezone">{t.settings.timezone}</Label>
          <Input
            id="agent-timezone"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder={t.settings.timezonePlaceholder}
            className="sm:max-w-sm"
          />
        </div>
        <BusinessHoursEditor
          value={businessHours}
          onChange={setBusinessHours}
          timezone={timezone || null}
        />
        <div className="space-y-2">
          <Label htmlFor="agent-ooh">{t.settings.outOfHoursResponse}</Label>
          <textarea
            id="agent-ooh"
            value={outOfHoursResponse}
            onChange={(e) => setOutOfHoursResponse(e.target.value)}
            rows={2}
            maxLength={300}
            placeholder={t.settings.outOfHoursPlaceholder}
            dir="auto"
            className={textarea}
          />
        </div>
      </section>

      {/* Intake Fields */}
      <section className="space-y-4">
        <IntakeFieldEditor
          value={intakeFields}
          onChange={setIntakeFields}
        />
      </section>

      {/* Routing */}
      <section className="space-y-4">
        <h3 id="agent-number-label" className="text-sm font-medium">
          {t.settings.whatsappNumber}
        </h3>
        {numbers.length === 0 ? (
          // D16 (Gulf T3): no card-before-connect gate. Numbers are
          // connected (Embedded Signup) on Settings → Channels.
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t.settings.noNumbersConnected}
            </p>
            <Button render={<Link href="/settings/channels" />} variant="outline" size="sm">
              <Cable className="size-4" />
              {t.channels.goToChannels}
            </Button>
          </div>
        ) : (
          <Select
            value={numberId ?? NONE}
            onValueChange={(v) => setNumberId(v === NONE ? null : v)}
          >
            <SelectTrigger
              aria-labelledby="agent-number-label"
              className="w-full sm:max-w-sm"
            >
              <SelectValue placeholder={t.settings.notConnected}>
                {() => {
                  const selected = numbers.find((n) => n.id === numberId);
                  if (!selected) return t.settings.notConnected;
                  return selected.boundAgentId && selected.boundAgentId !== agent.id
                    ? `${selected.phoneNumberId} · ${t.settings.inUse}`
                    : selected.phoneNumberId;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t.settings.notConnected}</SelectItem>
              {numbers.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.phoneNumberId}
                  {n.boundAgentId && n.boundAgentId !== agent.id
                    ? ` · ${t.settings.inUse}`
                    : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3 border-t border-border pt-5">
        <Button onClick={save} disabled={!dirty || saving || !name.trim()}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {t.settings.saveDraft}
        </Button>
        {dirty ? (
          <span className="text-xs text-muted-foreground">{t.settings.unsavedChanges}</span>
        ) : null}
      </div>
    </div>
  );
}
