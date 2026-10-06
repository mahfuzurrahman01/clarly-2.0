"use client";

import { useState } from "react";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteProduct, type ProductRecord } from "@/lib/api/catalog";
import {
  formatPrice,
  productName,
  productSecondaryName,
} from "@/lib/catalog/format";
import { asStockStatus } from "@/lib/catalog/product-form";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProductThumbnail } from "./product-thumbnail";
import { StockStatusBadge } from "./stock-status-badge";

/**
 * The products table. Kept as a real `<table>` at every width — overriding
 * `display` on table elements is what breaks table semantics for screen
 * readers — so narrow screens drop the two lowest-value columns (SKU,
 * category) instead of restyling rows into cards.
 */
export function ProductTable({
  products,
  onEdit,
  onDeleted,
}: {
  products: ProductRecord[];
  onEdit: (product: ProductRecord) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [pendingDelete, setPendingDelete] = useState<ProductRecord | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteProduct(pendingDelete.id);
      onDeleted(pendingDelete.id);
      toast.success(t.catalog.deletedToast);
      setPendingDelete(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.catalog.couldNotDelete));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[34rem] text-sm">
          <caption className="sr-only">{t.catalog.tableCaption}</caption>
          <thead className="bg-secondary/60 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                {t.catalog.colProduct}
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2 text-start font-medium md:table-cell"
              >
                {t.catalog.colSku}
              </th>
              <th
                scope="col"
                className="hidden px-4 py-2 text-start font-medium lg:table-cell"
              >
                {t.catalog.colCategory}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                {t.catalog.colPrice}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                {t.catalog.colStock}
              </th>
              <th scope="col" className="px-4 py-2 text-start font-medium">
                {t.catalog.colStatus}
              </th>
              <th scope="col" className="px-4 py-2 text-end font-medium">
                <span className="sr-only">{t.catalog.colActions}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const name = productName(product, locale);
              const secondary = productSecondaryName(product, locale);
              return (
                <tr key={product.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <ProductThumbnail src={product.imageUrl} name={name} />
                      <div className="min-w-0">
                        <p dir="auto" className="truncate text-start font-medium">
                          {name}
                        </p>
                        {secondary ? (
                          <p
                            dir="auto"
                            className="truncate text-start text-xs text-muted-foreground"
                          >
                            {secondary}
                          </p>
                        ) : null}
                        <p className="truncate font-mono text-xs text-muted-foreground md:hidden">
                          {product.sku ?? "—"}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                    <span className="font-mono" dir="ltr">
                      {product.sku ?? "—"}
                    </span>
                  </td>
                  <td className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                    {product.category ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-end whitespace-nowrap tabular-nums">
                    {formatPrice(product.price, product.currency, locale)}
                  </td>
                  <td className="px-4 py-3 text-end tabular-nums">
                    {product.stock ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StockStatusBadge
                      status={asStockStatus(product.stockStatus)}
                    />
                  </td>
                  <td className="px-4 py-3 text-end">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => onEdit(product)}
                        aria-label={t.catalog.editAriaTemplate.replace(
                          "{name}",
                          name,
                        )}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setPendingDelete(product)}
                        aria-label={t.catalog.deleteAriaTemplate.replace(
                          "{name}",
                          name,
                        )}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => (open ? null : setPendingDelete(null))}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t.catalog.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? t.catalog.deleteConfirmTemplate.replace(
                    "{name}",
                    productName(pendingDelete, locale),
                  )
                : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {t.catalog.deleteHint}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t.catalog.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t.catalog.deleteAction}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
