"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type KbDocument,
  type KbDocumentStatus,
  KB_MAX_UPLOAD_BYTES,
  deleteKbDocument,
  listKbDocuments,
  resolveKbMime,
  uploadKbDocument,
} from "@/lib/api/knowledge-base";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PENDING: KbDocumentStatus[] = ["uploaded", "ingest_queued"];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: KbDocumentStatus }) {
  const t = useTranslations();
  if (status === "ingested") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        <CheckCircle2 className="size-3" />
        {t.settings.ready}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title={t.settings.failedTooltip}
        className="inline-flex cursor-help items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs text-destructive"
      >
        <AlertTriangle className="size-3" />
        {t.settings.failed}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
      <Loader2 className="size-3 animate-spin" />
      {t.settings.processing}
    </span>
  );
}

export function KbManager({ initial }: { initial: KbDocument[] }) {
  const t = useTranslations();
  const [docs, setDocs] = useState<KbDocument[]>(initial);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasPending = docs.some((d) => PENDING.includes(d.status));

  // Poll while anything is still ingesting, so a fresh upload flips to Ready
  // without a manual refresh. Stops as soon as everything is terminal.
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(async () => {
      try {
        setDocs(await listKbDocuments());
      } catch {
        // transient — keep the current view, next tick retries
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        if (resolveKbMime(file) === null) {
          throw new ApiError(
            400,
            t.settings.unsupportedFileTemplate.replace("{name}", file.name),
          );
        }
        if (file.size > KB_MAX_UPLOAD_BYTES) {
          throw new ApiError(400, t.settings.fileTooLargeTemplate.replace("{name}", file.name));
        }
        const created = await uploadKbDocument(file);
        setDocs((prev) => [created, ...prev.filter((d) => d.id !== created.id)]);
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t.settings.uploadFailed,
      );
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }, []);

  async function remove(doc: KbDocument) {
    if (!confirm(t.settings.deleteConfirmTemplate.replace("{name}", doc.filename)))
      return;
    setError(null);
    setDeletingId(doc.id);
    const prev = docs;
    setDocs((d) => d.filter((x) => x.id !== doc.id)); // optimistic
    try {
      await deleteKbDocument(doc.id);
    } catch (err) {
      setDocs(prev); // roll back
      setError(apiErrorMessage(err, t, t.settings.couldNotDelete));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Uploader */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="text/*,.txt,.md,.csv,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,application/vnd.ms-excel,.xls"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
        <Button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          {t.settings.uploadDocument}
        </Button>
        <span className="text-xs text-muted-foreground">
          text, PDF, DOCX, XLSX · up to 10 MB
        </span>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* List */}
      {docs.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 p-10 text-center backdrop-blur-md">
          <FileText className="size-5 text-muted-foreground/60" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t.settings.noDocumentsBody}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur-md">
          {docs.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center gap-3 px-4 py-3"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{doc.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {formatBytes(doc.sizeBytes)}
                </p>
              </div>
              <StatusBadge status={doc.status} />
              <button
                type="button"
                onClick={() => remove(doc)}
                disabled={deletingId === doc.id}
                aria-label={t.settings.deleteAriaTemplate.replace("{name}", doc.filename)}
                className={cn(
                  "rounded-md p-1.5 text-muted-foreground transition-colors",
                  "hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
                )}
              >
                {deletingId === doc.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
