"use client";

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";
import {
  CSV_TEMPLATE_HEADER,
  MAX_IMPORT_CSV_BYTES,
  MAX_IMPORT_ROWS,
  importProductsCsv,
  type ImportResult,
} from "@/lib/api/catalog";
import { downloadCsv } from "@/lib/catalog/format";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const textareaClass =
  "w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

const EXAMPLE_ROW = "Dates 1kg,تمر ١ كجم,SKU-1,45.00,SAR,120,Food,,,gift";

function countDataRows(csv: string): number {
  return csv.split("\n").filter((line) => line.trim()).length - 1;
}

/**
 * CSV import. The server caps a request at 1000 data rows / 2 MB and reports
 * per-row failures rather than rejecting the file, so this dialog does two
 * things: it refuses an over-cap file before the upload (a two-minute wait
 * ending in a 400 is worse than an instant "split the file"), and it keeps
 * the row errors on screen after a partial import so they can be fixed.
 */
export function CsvImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after an import that wrote at least one row, so the list can refresh. */
  onImported: () => void;
}) {
  const t = useTranslations();
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function close() {
    onOpenChange(false);
    // Reset after the close transition so the panel doesn't visibly empty.
    setTimeout(() => {
      setCsv("");
      setResult(null);
      setError(null);
    }, 200);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setResult(null);
    if (file.size > MAX_IMPORT_CSV_BYTES) {
      setError(t.catalog.importTooLarge);
      return;
    }
    setCsv(await file.text());
  }

  async function submit() {
    const trimmed = csv.trim();
    if (!trimmed) {
      setError(t.catalog.importEmpty);
      return;
    }
    if (countDataRows(trimmed) < 1) {
      setError(t.catalog.importNoRows);
      return;
    }
    if (countDataRows(trimmed) > MAX_IMPORT_ROWS) {
      setError(
        t.catalog.importTooManyRowsTemplate.replace(
          "{max}",
          String(MAX_IMPORT_ROWS),
        ),
      );
      return;
    }
    if (new Blob([trimmed]).size > MAX_IMPORT_CSV_BYTES) {
      setError(t.catalog.importTooLarge);
      return;
    }

    setImporting(true);
    setError(null);
    try {
      const imported = await importProductsCsv(trimmed);
      setResult(imported);
      if (imported.imported + imported.updated > 0) onImported();
    } catch (err) {
      setError(apiErrorMessage(err, t, t.catalog.couldNotImport));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="max-h-[85svh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.catalog.importTitle}</DialogTitle>
          <DialogDescription>{t.catalog.importDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-secondary/40 p-3">
            <p className="text-xs font-medium">{t.catalog.importColumns}</p>
            <p
              dir="ltr"
              className="mt-1 overflow-x-auto font-mono text-[0.7rem] text-muted-foreground"
            >
              {CSV_TEMPLATE_HEADER}
            </p>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="mt-1 px-0"
              onClick={() =>
                downloadCsv(
                  `${CSV_TEMPLATE_HEADER}\n${EXAMPLE_ROW}\n`,
                  "clarly-products-template.csv",
                )
              }
            >
              {t.catalog.importDownloadTemplate}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                void onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="size-3.5" />
              {t.catalog.importChooseFile}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t.catalog.importOrPaste}
            </span>
          </div>

          <div className="space-y-2">
            <Label htmlFor="catalog-import-csv">
              {t.catalog.importCsvLabel}
            </Label>
            <textarea
              id="catalog-import-csv"
              dir="ltr"
              rows={8}
              spellCheck={false}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={`${CSV_TEMPLATE_HEADER}\n${EXAMPLE_ROW}`}
              className={textareaClass}
            />
            <p className="text-xs text-muted-foreground">
              {t.catalog.importRowLimitTemplate.replace(
                "{max}",
                String(MAX_IMPORT_ROWS),
              )}
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}

          {result ? <ImportReport result={result} /> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {result ? t.catalog.done : t.catalog.cancel}
          </Button>
          <Button type="button" onClick={submit} disabled={importing}>
            {importing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t.catalog.importAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportReport({ result }: { result: ImportResult }) {
  const t = useTranslations();
  const wrote = result.imported + result.updated;

  return (
    <div className="space-y-3" role="status">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs">
        {wrote > 0 ? (
          <CheckCircle2 className="size-3.5 text-lime-text" />
        ) : (
          <AlertTriangle className="size-3.5 text-destructive" />
        )}
        <span>
          {t.catalog.importSummaryTemplate
            .replace("{imported}", String(result.imported))
            .replace("{updated}", String(result.updated))
            .replace("{failed}", String(result.errors.length))}
        </span>
      </div>

      {result.errors.length > 0 ? (
        <div className="relative overflow-x-auto rounded-lg border border-destructive/40">
          <table className="w-full text-xs">
            <caption className="sr-only">
              {t.catalog.importErrorsCaption}
            </caption>
            <thead className="bg-destructive/5 text-destructive">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">
                  {t.catalog.importColRow}
                </th>
                <th scope="col" className="px-3 py-1.5 text-start font-medium">
                  {t.catalog.importColProblem}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.errors.map((rowError) => (
                <tr
                  key={`${rowError.row}-${rowError.message}`}
                  className="border-t border-destructive/20"
                >
                  <td className="px-3 py-1.5 tabular-nums">{rowError.row}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {rowError.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
