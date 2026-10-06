"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Package, Plus, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  PRODUCTS_PAGE_SIZE,
  STOCK_STATUSES,
  exportProductsCsv,
  listProducts,
  type ProductListResult,
  type ProductRecord,
  type StockStatus,
} from "@/lib/api/catalog";
import { downloadCsv } from "@/lib/catalog/format";
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
import { CsvImportDialog } from "./csv-import-dialog";
import { ProductFormDialog } from "./product-form-dialog";
import { ProductTable } from "./product-table";

const SEARCH_DEBOUNCE_MS = 300;

type StatusFilter = StockStatus | "all";

/**
 * F20 catalog console. The server component hands over page 1; every filter,
 * page and mutation after that goes through the browser client.
 *
 * Writes don't patch the local array optimistically (beyond an edit, which
 * cannot change the result set): create/import/delete all change `total` and
 * therefore which rows belong on this page, so they trigger a refetch. A
 * list that silently disagrees with the server about how many products exist
 * is worse than a 200ms spinner.
 */
export function CatalogManager({ initial }: { initial: ProductListResult }) {
  const t = useTranslations();

  const [products, setProducts] = useState(initial.products);
  const [total, setTotal] = useState(initial.total);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRecord | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
  // Page 1 with no filters is already on screen from the server render.
  const skipFirstFetch = useRef(true);

  useEffect(() => {
    if (skipFirstFetch.current) {
      skipFirstFetch.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    listProducts({
      search: debouncedSearch.trim() || undefined,
      stockStatus: status === "all" ? undefined : status,
      limit: PRODUCTS_PAGE_SIZE,
      offset,
    })
      .then((result) => {
        if (cancelled) return;
        setProducts(result.products);
        setTotal(result.total);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(apiErrorMessage(err, t, t.catalog.couldNotLoad));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `t` is stable for the session (server-resolved dictionary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, status, offset, reloadKey]);

  const refresh = useCallback(() => {
    skipFirstFetch.current = false;
    setReloadKey((key) => key + 1);
  }, []);

  function changeSearch(value: string) {
    setSearch(value);
    setOffset(0);
  }

  function changeStatus(value: StatusFilter) {
    setStatus(value);
    setOffset(0);
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(product: ProductRecord) {
    setEditing(product);
    setFormOpen(true);
  }

  function replaceRow(saved: ProductRecord) {
    setProducts((prev) =>
      prev.map((item) => (item.id === saved.id ? saved : item)),
    );
  }

  function onSaved(saved: ProductRecord) {
    if (editing) {
      replaceRow(saved);
      return;
    }
    // A new product may or may not belong on the current page — ask the server.
    setOffset(0);
    refresh();
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const { csv } = await exportProductsCsv();
      downloadCsv(csv, "clarly-products.csv");
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.catalog.couldNotExport));
    } finally {
      setExporting(false);
    }
  }

  const statusLabels: Record<StatusFilter, string> = {
    all: t.catalog.filterAll,
    in_stock: t.catalog.stockInStock,
    out_of_stock: t.catalog.stockOutOfStock,
    low_stock: t.catalog.stockLow,
    pre_order: t.catalog.stockPreOrder,
  };

  const filtered = search.trim() !== "" || status !== "all";
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + products.length, total);
  const hasPrev = offset > 0;
  const hasNext = offset + products.length < total;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="catalog-search">{t.catalog.searchLabel}</Label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="catalog-search"
                type="search"
                value={search}
                onChange={(e) => changeSearch(e.target.value)}
                placeholder={t.catalog.searchPlaceholder}
                className="w-56 ps-8"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="catalog-status-filter">
              {t.catalog.filterStatusLabel}
            </Label>
            <Select
              value={status}
              onValueChange={(value) => changeStatus(value as StatusFilter)}
            >
              <SelectTrigger id="catalog-status-filter" className="w-44">
                <SelectValue>{() => statusLabels[status]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{statusLabels.all}</SelectItem>
                {STOCK_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {statusLabels[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={exportCsv} disabled={exporting}>
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {t.catalog.exportAction}
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="size-4" />
            {t.catalog.importAction}
          </Button>
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            {t.catalog.newProduct}
          </Button>
        </div>
      </div>

      {loadError ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {loadError}
        </p>
      ) : null}

      <div
        aria-busy={loading}
        className={loading ? "opacity-60 transition-opacity" : undefined}
      >
        {products.length > 0 ? (
          <ProductTable
            products={products}
            onEdit={openEdit}
            onDeleted={() => refresh()}
          />
        ) : filtered ? (
          <EmptyFiltered
            onClear={() => {
              setSearch("");
              setStatus("all");
              setOffset(0);
            }}
          />
        ) : (
          <EmptyCatalog
            onCreate={openCreate}
            onImport={() => setImportOpen(true)}
          />
        )}
      </div>

      {products.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="text-xs text-muted-foreground tabular-nums"
            role="status"
          >
            {t.catalog.rangeTemplate
              .replace("{from}", String(from))
              .replace("{to}", String(to))
              .replace("{total}", String(total))}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!hasPrev || loading}
              onClick={() =>
                setOffset((current) =>
                  Math.max(0, current - PRODUCTS_PAGE_SIZE),
                )
              }
            >
              {t.catalog.previousPage}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasNext || loading}
              onClick={() =>
                setOffset((current) => current + PRODUCTS_PAGE_SIZE)
              }
            >
              {t.catalog.nextPage}
            </Button>
          </div>
        </div>
      ) : null}

      <ProductFormDialog
        open={formOpen}
        product={editing}
        onOpenChange={setFormOpen}
        onSaved={onSaved}
        onProductChanged={replaceRow}
      />
      <CsvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={refresh}
      />
    </div>
  );
}

/** First-run state: what the catalog is for, and the two ways to fill it. */
function EmptyCatalog({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-dashed border-border px-6 py-10">
      <Package className="size-5 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-1.5">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.catalog.emptyTitle}
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          {t.catalog.emptyBody}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onCreate}>
          <Plus className="size-4" />
          {t.catalog.emptyCreate}
        </Button>
        <Button variant="outline" onClick={onImport}>
          <Upload className="size-4" />
          {t.catalog.emptyImport}
        </Button>
      </div>
    </div>
  );
}

function EmptyFiltered({ onClear }: { onClear: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border px-6 py-10">
      <p className="text-sm text-muted-foreground">{t.catalog.noMatches}</p>
      <Button variant="outline" size="sm" onClick={onClear}>
        {t.catalog.clearFilters}
      </Button>
    </div>
  );
}

/** Keeps the list from firing a request per keystroke. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
