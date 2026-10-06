"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Download,
  FileDown,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import {
  type DataExportRecord,
  type DataExportStatus,
  downloadDataExport,
  listDataExports,
  requestDataExport,
} from "@/lib/api/data-exports";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

const POLL_MS = 4_000;
const IN_FLIGHT: DataExportStatus[] = ["pending", "running"];

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusBadge({ status }: { status: DataExportStatus }) {
  const t = useTranslations();
  const LABEL: Record<DataExportStatus, string> = {
    pending: t.dataExports.statusPending,
    running: t.dataExports.statusRunning,
    ready: t.dataExports.statusReady,
    failed: t.dataExports.statusFailed,
  };
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-lime-ring/40 bg-lime-soft/70 px-2 py-0.5 text-xs text-lime-text">
        {LABEL[status]}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/5 px-2 py-0.5 text-xs text-destructive">
        <AlertTriangle className="size-3" />
        {LABEL[status]}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
      <Clock className="size-3" />
      {LABEL[status]}
    </span>
  );
}

function isExpired(record: DataExportRecord): boolean {
  return record.status === "ready" && record.expiresAt !== null && new Date(record.expiresAt) < new Date();
}

export function DataExportManager({
  initialExports,
}: {
  initialExports: DataExportRecord[];
}) {
  const t = useTranslations();
  const [exports, setExports] = useState(initialExports);
  const [requesting, setRequesting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const exportsRef = useRef(exports);

  useEffect(() => {
    exportsRef.current = exports;
  }, [exports]);

  useEffect(() => {
    const id = setInterval(async () => {
      if (!exportsRef.current.some((e) => IN_FLIGHT.includes(e.status))) return;
      try {
        setExports(await listDataExports());
      } catch {
        // Transient poll failure — try again next tick.
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  async function request() {
    setRequesting(true);
    try {
      const record = await requestDataExport();
      setExports((prev) => [record, ...prev]);
      toast.success(t.dataExports.requested);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t.dataExports.alreadyInFlight
          : t.dataExports.couldNotRequest,
      );
    } finally {
      setRequesting(false);
    }
  }

  async function download(record: DataExportRecord) {
    setDownloadingId(record.id);
    try {
      await downloadDataExport(record.id, `clarly-export-${record.id}.json`);
    } catch (err) {
      toast.error(
        apiErrorMessage(err, t, t.dataExports.couldNotDownload),
      );
    } finally {
      setDownloadingId(null);
    }
  }

  const hasInFlight = exports.some((e) => IN_FLIGHT.includes(e.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <div>
          <p className="text-sm font-medium">{t.dataExports.requestTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.dataExports.requestHint}</p>
        </div>
        <Button onClick={request} disabled={requesting || hasInFlight}>
          {requesting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FileDown className="size-4" />
          )}
          {t.dataExports.requestButton}
        </Button>
      </div>

      <div className="space-y-2">
        {exports.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.dataExports.empty}</p>
        ) : (
          exports.map((record) => {
            const expired = isExpired(record);
            return (
              <div
                key={record.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 backdrop-blur-md"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={record.status} />
                    {expired ? (
                      <span className="eyebrow text-muted-foreground">
                        {t.dataExports.expired}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(record.createdAt).toLocaleString()}
                    {record.sizeBytes !== null ? ` · ${formatBytes(record.sizeBytes)}` : ""}
                  </p>
                  {record.status === "failed" && record.error ? (
                    <p className="mt-1 text-xs text-destructive">{record.error}</p>
                  ) : null}
                  {record.rowCounts ? (
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {Object.entries(record.rowCounts)
                        .map(([table, count]) => `${table}: ${count}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                </div>
                {record.status === "ready" && !expired ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => download(record)}
                    disabled={downloadingId === record.id}
                  >
                    {downloadingId === record.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    {t.dataExports.download}
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
