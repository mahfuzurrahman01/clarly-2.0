"use client";

import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ImagePlus, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import {
  CURRENCIES,
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_ACCEPT,
  STOCK_STATUSES,
  createProduct,
  updateProduct,
  uploadProductImage,
  type Currency,
  type ProductRecord,
  type StockStatus,
} from "@/lib/api/catalog";
import {
  EMPTY_PRODUCT_FORM,
  productFormSchema,
  productToForm,
  toCreateInput,
  toUpdateInput,
  type ProductFormValues,
} from "@/lib/catalog/product-form";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/auth/field";
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
import { ProductThumbnail } from "./product-thumbnail";

const textareaClass =
  "w-full resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors hover:border-lime-ring/60 focus-visible:border-lime-ring focus-visible:ring-3 focus-visible:ring-lime-ring/40";

/**
 * Create / edit a product. One dialog for both: the only difference is the
 * request it sends on submit (POST vs a diff-based PATCH), so the fields,
 * validation and copy stay in one place.
 */
export function ProductFormDialog({
  open,
  product,
  onOpenChange,
  onSaved,
  onProductChanged,
}: {
  open: boolean;
  /** null → create mode. */
  product: ProductRecord | null;
  onOpenChange: (open: boolean) => void;
  /** A completed create/edit. The dialog closes right after. */
  onSaved: (product: ProductRecord) => void;
  /**
   * A server-side change made while the dialog stays open (an image upload).
   * Kept separate from `onSaved` so the parent refreshes the row WITHOUT
   * handing back a new `product` prop — that would re-seed the form and
   * discard whatever else is being typed.
   */
  onProductChanged: (product: ProductRecord) => void;
}) {
  const t = useTranslations();
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    formState: { errors },
  } = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema(t)),
    defaultValues: EMPTY_PRODUCT_FORM,
  });

  // Re-seed when the dialog opens or switches product. `product` is a stable
  // reference for as long as the dialog is open (see `onProductChanged`), so
  // this never fires mid-edit.
  useEffect(() => {
    if (!open) return;
    reset(product ? productToForm(product) : EMPTY_PRODUCT_FORM);
  }, [open, product, reset]);

  // `useWatch` rather than `watch()`: it returns values, so the component
  // stays memoizable by the React Compiler.
  const currency = useWatch({ control, name: "currency" });
  const stockStatus = useWatch({ control, name: "stockStatus" });
  const imageUrl = useWatch({ control, name: "imageUrl" });

  async function onSubmit(values: ProductFormValues) {
    setSubmitting(true);
    try {
      if (product) {
        const patch = toUpdateInput(values, product);
        if (Object.keys(patch).length === 0) {
          // An empty PATCH body is a 400 by design — nothing changed, so close.
          onOpenChange(false);
          return;
        }
        const updated = await updateProduct(product.id, patch);
        onSaved(updated);
        toast.success(t.catalog.savedToast);
      } else {
        const created = await createProduct(toCreateInput(values));
        onSaved(created);
        toast.success(t.catalog.createdToast);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.catalog.couldNotSave));
    } finally {
      setSubmitting(false);
    }
  }

  async function onImageFile(file: File | undefined) {
    if (!file || !product) return;
    if (file.size > MAX_PRODUCT_IMAGE_BYTES) {
      toast.error(t.catalog.imageTooLarge);
      return;
    }
    setUploading(true);
    try {
      const updated = await uploadProductImage(product.id, file);
      // The server owns `imageUrl` for an uploaded photo — take its value so
      // the next PATCH doesn't diff against a stale one.
      setValue("imageUrl", updated.imageUrl ?? "", { shouldDirty: false });
      onProductChanged(updated);
      toast.success(t.catalog.imageUploaded);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.catalog.couldNotUploadImage));
    } finally {
      setUploading(false);
    }
  }

  const stockStatusLabels: Record<StockStatus, string> = {
    in_stock: t.catalog.stockInStock,
    out_of_stock: t.catalog.stockOutOfStock,
    low_stock: t.catalog.stockLow,
    pre_order: t.catalog.stockPreOrder,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {product ? t.catalog.editTitle : t.catalog.newTitle}
          </DialogTitle>
          <DialogDescription>
            {product ? t.catalog.editDescription : t.catalog.newDescription}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit(onSubmit)}
          className="space-y-5"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="product-name"
              label={t.catalog.fieldName}
              error={errors.name?.message}
            >
              <Input
                id="product-name"
                autoComplete="off"
                placeholder={t.catalog.fieldNamePlaceholder}
                aria-invalid={errors.name ? true : undefined}
                {...register("name")}
              />
            </Field>
            <Field
              id="product-name-ar"
              label={t.catalog.fieldNameAr}
              error={errors.nameAr?.message}
              hint={t.catalog.fieldNameArHint}
            >
              <Input
                id="product-name-ar"
                dir="rtl"
                lang="ar"
                autoComplete="off"
                aria-invalid={errors.nameAr ? true : undefined}
                {...register("nameAr")}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="product-sku"
              label={t.catalog.fieldSku}
              error={errors.sku?.message}
              hint={t.catalog.fieldSkuHint}
            >
              <Input
                id="product-sku"
                autoComplete="off"
                aria-invalid={errors.sku ? true : undefined}
                {...register("sku")}
              />
            </Field>
            <Field
              id="product-category"
              label={t.catalog.fieldCategory}
              error={errors.category?.message}
            >
              <Input
                id="product-category"
                autoComplete="off"
                aria-invalid={errors.category ? true : undefined}
                {...register("category")}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field
              id="product-price"
              label={t.catalog.fieldPrice}
              error={errors.price?.message}
            >
              <Input
                id="product-price"
                inputMode="decimal"
                dir="ltr"
                autoComplete="off"
                placeholder="0.00"
                aria-invalid={errors.price ? true : undefined}
                className="tabular-nums"
                {...register("price")}
              />
            </Field>
            <div className="space-y-2">
              <Label htmlFor="product-currency">
                {t.catalog.fieldCurrency}
              </Label>
              <Select
                value={currency}
                onValueChange={(value) =>
                  setValue("currency", value as Currency, {
                    shouldDirty: true,
                  })
                }
              >
                <SelectTrigger id="product-currency" className="w-full">
                  <SelectValue>{() => currency}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="product-stock"
              label={t.catalog.fieldStock}
              error={errors.stock?.message}
            >
              <Input
                id="product-stock"
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                aria-invalid={errors.stock ? true : undefined}
                className="tabular-nums"
                {...register("stock")}
              />
            </Field>
            <div className="space-y-2">
              <Label htmlFor="product-stock-status">
                {t.catalog.fieldStockStatus}
              </Label>
              <Select
                value={stockStatus}
                onValueChange={(value) =>
                  setValue("stockStatus", value as StockStatus, {
                    shouldDirty: true,
                  })
                }
              >
                <SelectTrigger id="product-stock-status" className="w-full">
                  <SelectValue>
                    {() => stockStatusLabels[stockStatus]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STOCK_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {stockStatusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t.catalog.fieldStockStatusHint}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="product-description"
              label={t.catalog.fieldDescription}
              error={errors.description?.message}
              hint={t.catalog.fieldDescriptionHint}
            >
              <textarea
                id="product-description"
                rows={3}
                className={textareaClass}
                aria-invalid={errors.description ? true : undefined}
                {...register("description")}
              />
            </Field>
            <Field
              id="product-description-ar"
              label={t.catalog.fieldDescriptionAr}
              error={errors.descriptionAr?.message}
            >
              <textarea
                id="product-description-ar"
                rows={3}
                dir="rtl"
                lang="ar"
                className={textareaClass}
                aria-invalid={errors.descriptionAr ? true : undefined}
                {...register("descriptionAr")}
              />
            </Field>
          </div>

          <Field
            id="product-tags"
            label={t.catalog.fieldTags}
            error={errors.tags?.message}
            hint={t.catalog.fieldTagsHint}
          >
            <Input
              id="product-tags"
              autoComplete="off"
              aria-invalid={errors.tags ? true : undefined}
              {...register("tags")}
            />
          </Field>

          <div className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex items-start gap-3">
              <ProductThumbnail
                src={imageUrl?.trim() ? imageUrl.trim() : null}
                name={t.catalog.imagePreviewAlt}
                className="size-14"
              />
              <div className="flex-1 space-y-1.5">
                <p className="text-sm font-medium">{t.catalog.imageSection}</p>
                <p className="text-xs text-muted-foreground">
                  {product
                    ? t.catalog.imageUploadHint
                    : t.catalog.imageUploadAfterSave}
                </p>
                <input
                  ref={fileRef}
                  type="file"
                  accept={PRODUCT_IMAGE_ACCEPT}
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    void onImageFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!product || uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <ImagePlus className="size-3.5" />
                  )}
                  {t.catalog.imageUploadAction}
                </Button>
              </div>
            </div>

            <Field
              id="product-image-url"
              label={t.catalog.fieldImageUrl}
              error={errors.imageUrl?.message}
              hint={t.catalog.fieldImageUrlHint}
            >
              <Input
                id="product-image-url"
                type="url"
                dir="ltr"
                autoComplete="off"
                placeholder="https://"
                aria-invalid={errors.imageUrl ? true : undefined}
                {...register("imageUrl")}
              />
            </Field>
          </div>

          {/* The form scrolls inside an 85svh dialog; pin the actions to its
              bottom edge so Save is reachable without scrolling past every field.
              `-bottom-6` offsets the dialog padding, which Chromium excludes from
              the sticky area. */}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 rounded-b-xl border-t border-border bg-popover px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {t.catalog.cancel}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {product ? t.catalog.saveChanges : t.catalog.createProduct}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
