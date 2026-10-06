"use client";

import { useState } from "react";
import { Loader2, Plus, Users } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_SEGMENT_DESCRIPTION_LENGTH,
  MAX_SEGMENT_LEAVES,
  MAX_SEGMENT_NAME_LENGTH,
  createSegment,
  deleteSegment,
  isCriterionNotImplemented,
  previewSegment,
  updateSegment,
  type SegmentRecord,
} from "@/lib/api/campaigns";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CriterionRow, useCriterionLabels } from "./criterion-row";
import { fill, formatCount, formatDateTime } from "./format";
import {
  defaultCriterion,
  expandDefinition,
  flattenDefinition,
  isCriterionComplete,
  type FlatDefinition,
} from "./segment-definition";

type Draft = {
  id: string | null;
  name: string;
  description: string;
  definition: FlatDefinition;
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  description: "",
  definition: { match: "and", rules: [] },
};

/**
 * Audiences (the API's segments). An audience is a saved rule re-counted on
 * demand — the count shown here is advisory, and the set that actually gets
 * messaged is snapshotted only when a campaign launches (D1).
 */
export function AudienceManager({ initial }: { initial: SegmentRecord[] }) {
  const t = useTranslations();
  const locale = useLocale();
  const labels = useCriterionLabels();

  const [segments, setSegments] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SegmentRecord | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setDraft({ ...EMPTY_DRAFT, definition: { match: "and", rules: [] } });
  }

  function openEdit(segment: SegmentRecord) {
    const flat = flattenDefinition(segment.definition);
    if (!flat) {
      toast.error(t.campaigns.segment.unsupportedShape);
      return;
    }
    setDraft({
      id: segment.id,
      name: segment.name,
      description: segment.description ?? "",
      definition: flat,
    });
  }

  const incomplete =
    draft !== null &&
    (draft.name.trim().length === 0 ||
      draft.definition.rules.length === 0 ||
      draft.definition.rules.some(
        (rule) => !isCriterionComplete(rule.criterion),
      ));

  async function save() {
    if (!draft || incomplete) return;
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        definition: expandDefinition(draft.definition),
      };
      const saved = draft.id
        ? await updateSegment(draft.id, body)
        : await createSegment(body);
      setSegments((prev) =>
        draft.id
          ? prev.map((item) => (item.id === saved.id ? saved : item))
          : [saved, ...prev],
      );
      setDraft(null);
      toast.success(t.campaigns.segment.saved);
      // Counting straight after a save is what makes the rule concrete —
      // a saved audience with no number attached to it teaches nothing.
      void runPreview(saved.id);
    } catch (err) {
      toast.error(failureMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function failureMessage(err: unknown): string {
    if (isCriterionNotImplemented(err)) {
      return t.campaigns.criteria.notAvailableBody;
    }
    return apiErrorMessage(err, t, t.campaigns.segment.couldNotSave);
  }

  async function runPreview(id: string) {
    setPreviewing(id);
    try {
      const result = await previewSegment(id);
      setSegments((prev) =>
        prev.map((segment) =>
          segment.id === id
            ? {
                ...segment,
                lastResolvedCount: result.count,
                lastResolvedAt: result.resolvedAt,
              }
            : segment,
        ),
      );
    } catch (err) {
      toast.error(
        isCriterionNotImplemented(err)
          ? t.campaigns.criteria.notAvailableBody
          : apiErrorMessage(err, t, t.campaigns.segment.couldNotPreview),
      );
    } finally {
      setPreviewing(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteSegment(pendingDelete.id);
      setSegments((prev) =>
        prev.filter((segment) => segment.id !== pendingDelete.id),
      );
      setPendingDelete(null);
      toast.success(t.campaigns.segment.deleted);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.campaigns.segment.couldNotDelete),
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
          {t.campaigns.segment.subtitle}
        </p>
        {draft === null ? (
          <Button onClick={openCreate}>
            <Plus data-icon="inline-start" />
            {t.campaigns.segment.create}
          </Button>
        ) : null}
      </div>

      {draft !== null ? (
        <section className="space-y-5 rounded-xl border border-border bg-card p-5">
          <h2 className="font-display text-lg font-medium tracking-tight">
            {draft.id
              ? t.campaigns.segment.editTitle
              : t.campaigns.segment.createTitle}
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="audience-name">
                {t.campaigns.segment.nameLabel}
              </Label>
              <Input
                id="audience-name"
                value={draft.name}
                maxLength={MAX_SEGMENT_NAME_LENGTH}
                placeholder={t.campaigns.segment.namePlaceholder}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audience-description">
                {t.campaigns.segment.descriptionLabel}
              </Label>
              <Input
                id="audience-description"
                value={draft.description}
                maxLength={MAX_SEGMENT_DESCRIPTION_LENGTH}
                placeholder={t.campaigns.segment.descriptionPlaceholder}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="audience-match" className="text-sm">
              {t.campaigns.segment.matchLabel}
            </Label>
            <Select
              value={draft.definition.match}
              onValueChange={(next) =>
                setDraft({
                  ...draft,
                  definition: {
                    ...draft.definition,
                    match: next as "and" | "or",
                  },
                })
              }
            >
              <SelectTrigger id="audience-match" className="w-56">
                <SelectValue>
                  {() =>
                    draft.definition.match === "and"
                      ? t.campaigns.segment.matchAll
                      : t.campaigns.segment.matchAny
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="and">
                  {t.campaigns.segment.matchAll}
                </SelectItem>
                <SelectItem value="or">
                  {t.campaigns.segment.matchAny}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-3">
            {draft.definition.rules.map((rule, index) => (
              <CriterionRow
                key={index}
                rule={rule}
                index={index}
                onChange={(next) =>
                  setDraft({
                    ...draft,
                    definition: {
                      ...draft.definition,
                      rules: draft.definition.rules.map((item, i) =>
                        i === index ? next : item,
                      ),
                    },
                  })
                }
                onRemove={() =>
                  setDraft({
                    ...draft,
                    definition: {
                      ...draft.definition,
                      rules: draft.definition.rules.filter(
                        (_, i) => i !== index,
                      ),
                    },
                  })
                }
              />
            ))}

            {draft.definition.rules.length === 0 ? (
              <p className="max-w-[65ch] rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                {t.campaigns.segment.noRules}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  draft.definition.rules.length >= MAX_SEGMENT_LEAVES
                }
                onClick={() =>
                  setDraft({
                    ...draft,
                    definition: {
                      ...draft.definition,
                      rules: [
                        ...draft.definition.rules,
                        { criterion: defaultCriterion("label"), negated: false },
                      ],
                    },
                  })
                }
              >
                <Plus data-icon="inline-start" />
                {t.campaigns.segment.addRule}
              </Button>
              {draft.definition.rules.length >= MAX_SEGMENT_LEAVES ? (
                <span className="text-xs text-muted-foreground">
                  {fill(t.campaigns.segment.tooManyRules, {
                    max: formatCount(MAX_SEGMENT_LEAVES, locale),
                  })}
                </span>
              ) : null}
            </div>
          </div>

          <p className="max-w-[65ch] text-xs text-muted-foreground">
            {t.campaigns.segment.consentNote}
          </p>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button onClick={save} disabled={saving || incomplete}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.segment.save}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              {t.campaigns.compose.cancel}
            </Button>
          </div>
        </section>
      ) : null}

      {segments.length === 0 && draft === null ? (
        <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <Users className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-display text-lg">
            {t.campaigns.segment.empty}
          </p>
          <p className="mx-auto mt-1 max-w-[50ch] text-sm text-muted-foreground">
            {t.campaigns.segment.emptyBody}
          </p>
          <Button className="mt-5" onClick={openCreate}>
            {t.campaigns.segment.create}
          </Button>
        </div>
      ) : null}

      <ul className="space-y-3">
        {segments.map((segment) => {
          const flat = flattenDefinition(segment.definition);
          return (
            <li
              key={segment.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h3 className="font-medium text-foreground">
                    {segment.name}
                  </h3>
                  {segment.description ? (
                    <p className="max-w-[65ch] text-sm text-muted-foreground">
                      {segment.description}
                    </p>
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {flat
                      ? flat.rules
                          .map(
                            (rule) =>
                              `${rule.negated ? "¬ " : ""}${labels[rule.criterion.kind]}`,
                          )
                          .join(
                            flat.match === "and"
                              ? ` · ${t.campaigns.segment.matchAll} · `
                              : ` · ${t.campaigns.segment.matchAny} · `,
                          )
                      : t.campaigns.segment.unsupportedShape}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="text-end">
                    <p className="font-display text-xl tabular-nums text-foreground">
                      {segment.lastResolvedCount === null
                        ? "—"
                        : formatCount(segment.lastResolvedCount, locale)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {segment.lastResolvedAt
                        ? fill(t.campaigns.segment.previewAt, {
                            time: formatDateTime(segment.lastResolvedAt, locale),
                          })
                        : t.campaigns.segment.previewNever}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={previewing === segment.id}
                  onClick={() => runPreview(segment.id)}
                >
                  {previewing === segment.id ? (
                    <Loader2 className="animate-spin" />
                  ) : null}
                  {previewing === segment.id
                    ? t.campaigns.segment.previewing
                    : t.campaigns.segment.preview}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!flat}
                  onClick={() => openEdit(segment)}
                >
                  {t.campaigns.segment.edit}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => setPendingDelete(segment)}
                >
                  {t.campaigns.segment.delete}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.campaigns.segment.deleteTitle}</DialogTitle>
            <DialogDescription>
              {t.campaigns.segment.deleteBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleting ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.segment.deleteConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
