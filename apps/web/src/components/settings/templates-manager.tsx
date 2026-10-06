"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  type CreateTemplateInput,
  type MessageTemplateRecord,
  type TemplateApprovalStatus,
  type TemplateCategory,
  type TemplateKind,
  type TemplateVariable,
  createTemplate,
  deleteTemplate,
  submitTemplate,
  syncTemplates,
  updateTemplate,
} from "@/lib/api/templates";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
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

const textarea =
  "w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

type DraftVariable = TemplateVariable;

type Draft = {
  kind: TemplateKind;
  name: string;
  language: string;
  category: TemplateCategory | "";
  body: string;
  variables: DraftVariable[];
};

const EMPTY_DRAFT: Draft = {
  kind: "canned_reply",
  name: "",
  language: "en",
  category: "",
  body: "",
  variables: [],
};

function StatusBadge({ status }: { status: TemplateApprovalStatus }) {
  const t = useTranslations();
  const LABEL: Record<TemplateApprovalStatus, string> = {
    local: t.templates.statusLocal,
    pending: t.templates.statusPending,
    approved: t.templates.statusApproved,
    rejected: t.templates.statusRejected,
    paused: t.templates.statusPaused,
    disabled: t.templates.statusDisabled,
  };
  if (status === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        <CheckCircle2 className="size-3" />
        {LABEL[status]}
      </span>
    );
  }
  if (status === "rejected" || status === "disabled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs text-destructive">
        <AlertTriangle className="size-3" />
        {LABEL[status]}
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
        <Clock className="size-3" />
        {LABEL[status]}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      {LABEL[status]}
    </span>
  );
}

function VariablesEditor({
  variables,
  onChange,
}: {
  variables: DraftVariable[];
  onChange: (next: DraftVariable[]) => void;
}) {
  const t = useTranslations();

  function add() {
    onChange([
      ...variables,
      { position: variables.length + 1, label: "", example: null },
    ]);
  }
  function update(index: number, patch: Partial<DraftVariable>) {
    onChange(variables.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }
  function remove(index: number) {
    onChange(
      variables
        .filter((_, i) => i !== index)
        .map((v, i) => ({ ...v, position: i + 1 })),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t.templates.variablesLabel}</Label>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="size-3.5" />
          {t.templates.addVariable}
        </Button>
      </div>
      {variables.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t.templates.noVariables}</p>
      ) : (
        <div className="space-y-2">
          {variables.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-center text-xs text-muted-foreground">
                {`{{${v.position}}}`}
              </span>
              <Input
                value={v.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder={t.templates.variableLabelPlaceholder}
                className="flex-1"
              />
              <Input
                value={v.example ?? ""}
                onChange={(e) => update(i, { example: e.target.value || null })}
                placeholder={t.templates.variableExamplePlaceholder}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => remove(i)}
                aria-label={t.templates.removeVariable}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateForm({
  draft,
  onChange,
  editingKind,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  /** Kind is fixed once created — Meta's own identity for the template. */
  editingKind: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t.templates.kindLabel}</Label>
          <Select
            value={draft.kind}
            onValueChange={(v) => onChange({ ...draft, kind: v as TemplateKind })}
            disabled={editingKind}
          >
            <SelectTrigger>
              <SelectValue>
                {() =>
                  draft.kind === "whatsapp_template"
                    ? t.templates.kindWhatsapp
                    : t.templates.kindCanned
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="canned_reply">{t.templates.kindCanned}</SelectItem>
              <SelectItem value="whatsapp_template">{t.templates.kindWhatsapp}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t.templates.nameLabel}</Label>
          <Input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            disabled={editingKind}
            placeholder={
              draft.kind === "whatsapp_template"
                ? t.templates.namePlaceholderWhatsapp
                : t.templates.namePlaceholderCanned
            }
          />
        </div>
      </div>

      {draft.kind === "whatsapp_template" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t.templates.languageLabel}</Label>
            <Input
              value={draft.language}
              onChange={(e) => onChange({ ...draft, language: e.target.value })}
              disabled={editingKind}
              placeholder="en"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t.templates.categoryLabel}</Label>
            <Select
              value={draft.category || undefined}
              onValueChange={(v) =>
                onChange({ ...draft, category: v as TemplateCategory })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder={t.templates.categoryPlaceholder}>
                  {() => {
                    switch (draft.category) {
                      case "UTILITY":
                        return t.templates.categoryUtility;
                      case "MARKETING":
                        return t.templates.categoryMarketing;
                      case "AUTHENTICATION":
                        return t.templates.categoryAuthentication;
                      default:
                        return t.templates.categoryPlaceholder;
                    }
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="UTILITY">{t.templates.categoryUtility}</SelectItem>
                <SelectItem value="MARKETING">{t.templates.categoryMarketing}</SelectItem>
                <SelectItem value="AUTHENTICATION">
                  {t.templates.categoryAuthentication}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label>{t.templates.bodyLabel}</Label>
        <textarea
          value={draft.body}
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          rows={4}
          placeholder={t.templates.bodyPlaceholder}
          className={textarea}
        />
        <p className="text-xs text-muted-foreground">{t.templates.bodyHint}</p>
      </div>

      <VariablesEditor
        variables={draft.variables}
        onChange={(variables) => onChange({ ...draft, variables })}
      />
    </div>
  );
}

function TemplateRow({
  template,
  onUpdated,
  onDeleted,
}: {
  template: MessageTemplateRecord;
  onUpdated: (updated: MessageTemplateRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    kind: template.kind,
    name: template.name,
    language: template.language,
    category: template.category ?? "",
    body: template.body,
    variables: template.variables,
  });
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const updated = await updateTemplate(template.id, {
        category: draft.category || null,
        body: draft.body,
        variables: draft.variables,
      });
      onUpdated(updated);
      setExpanded(false);
      toast.success(t.templates.saved);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.templates.couldNotSave),
      );
    } finally {
      setSaving(false);
    }
  }

  async function submit() {
    setSubmitting(true);
    try {
      const result = await submitTemplate(template.id);
      if (result.submitted) {
        toast.success(t.templates.submitted);
      } else {
        toast.error(result.unsupportedReason ?? t.templates.couldNotSubmit);
      }
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.templates.couldNotSubmit),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await deleteTemplate(template.id);
      onDeleted(template.id);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.templates.couldNotDelete),
      );
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card/60 backdrop-blur-md">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-start"
        >
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{template.name}</span>
              <span className="eyebrow text-muted-foreground">
                {template.kind === "whatsapp_template"
                  ? t.templates.kindWhatsapp
                  : t.templates.kindCanned}
              </span>
              {template.kind === "whatsapp_template" ? (
                <StatusBadge status={template.approvalStatus} />
              ) : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {template.body}
            </p>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {template.kind === "whatsapp_template" &&
          (template.approvalStatus === "local" ||
            template.approvalStatus === "pending" ||
            template.approvalStatus === "rejected") ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              {t.templates.submit}
            </Button>
          ) : null}
          {confirmDelete ? (
            <>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={remove}
                disabled={deleting}
              >
                {deleting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {t.templates.confirmDelete}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmDelete(false)}
              >
                {t.templates.cancel}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              aria-label={t.templates.remove}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {template.approvalStatus === "rejected" && template.approvalDetail ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {template.approvalDetail}
            </p>
          ) : null}
          <TemplateForm draft={draft} onChange={setDraft} editingKind />
          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              {t.templates.save}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function TemplatesManager({
  initialTemplates,
}: {
  initialTemplates: MessageTemplateRecord[];
}) {
  const t = useTranslations();
  const [templates, setTemplates] = useState(initialTemplates);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function create() {
    setSaving(true);
    try {
      const input: CreateTemplateInput = {
        kind: draft.kind,
        name: draft.name.trim(),
        language: draft.language.trim() || "en",
        category: draft.kind === "whatsapp_template" ? draft.category || null : null,
        body: draft.body,
        variables: draft.variables,
      };
      const created = await createTemplate(input);
      setTemplates((prev) => [created, ...prev]);
      setDraft(EMPTY_DRAFT);
      setCreating(false);
      toast.success(t.templates.created);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.templates.couldNotCreate),
      );
    } finally {
      setSaving(false);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const result = await syncTemplates();
      if (result.unreported) {
        toast.error(t.templates.syncUnreported);
      } else {
        toast.success(
          t.templates.syncResultTemplate
            .replace("{count}", String(result.updated))
            .replace("{unknown}", String(result.unknownToBsp.length)),
        );
      }
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.templates.couldNotSync),
      );
    } finally {
      setSyncing(false);
    }
  }

  const whatsappTemplates = templates.filter((tpl) => tpl.kind === "whatsapp_template");
  const cannedReplies = templates.filter((tpl) => tpl.kind === "canned_reply");

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="outline" onClick={sync} disabled={syncing}>
          {syncing ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          {t.templates.sync}
        </Button>
        {!creating ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            {t.templates.addTemplate}
          </Button>
        ) : null}
      </div>

      {creating ? (
        <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
          <h3 className="mb-4 text-sm font-medium">{t.templates.newTemplate}</h3>
          <TemplateForm draft={draft} onChange={setDraft} editingKind={false} />
          <div className="mt-4 flex items-center gap-3">
            <Button
              onClick={create}
              disabled={saving || !draft.name.trim() || !draft.body.trim()}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              {t.templates.create}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setDraft(EMPTY_DRAFT);
              }}
            >
              {t.templates.cancel}
            </Button>
          </div>
        </section>
      ) : null}

      <div className="space-y-3">
        <h3 className="eyebrow text-muted-foreground">{t.templates.whatsappSection}</h3>
        {whatsappTemplates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.templates.noWhatsappTemplates}</p>
        ) : (
          <div className="space-y-2">
            {whatsappTemplates.map((tpl) => (
              <TemplateRow
                key={tpl.id}
                template={tpl}
                onUpdated={(updated) =>
                  setTemplates((prev) => prev.map((it) => (it.id === updated.id ? updated : it)))
                }
                onDeleted={(id) => setTemplates((prev) => prev.filter((it) => it.id !== id))}
              />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="eyebrow text-muted-foreground">{t.templates.cannedSection}</h3>
        {cannedReplies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.templates.noCannedReplies}</p>
        ) : (
          <div className="space-y-2">
            {cannedReplies.map((tpl) => (
              <TemplateRow
                key={tpl.id}
                template={tpl}
                onUpdated={(updated) =>
                  setTemplates((prev) => prev.map((it) => (it.id === updated.id ? updated : it)))
                }
                onDeleted={(id) => setTemplates((prev) => prev.filter((it) => it.id !== id))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
