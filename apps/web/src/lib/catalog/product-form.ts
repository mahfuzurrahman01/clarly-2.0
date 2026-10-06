import { z } from "zod";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import {
  CURRENCIES,
  MAX_CATEGORY_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_IMAGE_URL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PRICE,
  MAX_SKU_LENGTH,
  MAX_STOCK,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  STOCK_STATUSES,
  type CreateProductInput,
  type Currency,
  type ProductRecord,
  type StockStatus,
  type UpdateProductInput,
} from "@/lib/api/catalog";

/**
 * The product form's own shape: every control is a string, because that is
 * what an `<input>` holds. `price`/`stock` are converted exactly once, on
 * submit, in `toCreateInput` — a `parseFloat` sprinkled through the render
 * path is how "0.00 SAR" products get created (the same failure mode the
 * server's importer refuses to have).
 */
export type ProductFormValues = {
  name: string;
  nameAr: string;
  sku: string;
  description: string;
  descriptionAr: string;
  price: string;
  currency: Currency;
  stock: string;
  stockStatus: StockStatus;
  category: string;
  tags: string;
  imageUrl: string;
};

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  name: "",
  nameAr: "",
  sku: "",
  description: "",
  descriptionAr: "",
  price: "",
  currency: "SAR",
  stock: "0",
  stockStatus: "in_stock",
  category: "",
  tags: "",
  imageUrl: "",
};

export function productToForm(product: ProductRecord): ProductFormValues {
  return {
    name: product.name,
    nameAr: product.nameAr ?? "",
    sku: product.sku ?? "",
    description: product.description ?? "",
    descriptionAr: product.descriptionAr ?? "",
    price: product.price,
    currency: asCurrency(product.currency),
    stock: product.stock === null ? "" : String(product.stock),
    stockStatus: asStockStatus(product.stockStatus),
    category: product.category ?? "",
    tags: (product.tags ?? []).join(", "),
    imageUrl: product.imageUrl ?? "",
  };
}

/** Columns are plain `text`, so a value from an older row may not be in the current enum. */
export function asCurrency(value: string): Currency {
  return (CURRENCIES as readonly string[]).includes(value)
    ? (value as Currency)
    : "SAR";
}

export function asStockStatus(value: string): StockStatus {
  return (STOCK_STATUSES as readonly string[]).includes(value)
    ? (value as StockStatus)
    : "in_stock";
}

/** `a, b , ,c` → `["a", "b", "c"]`. Blank entries are dropped, not sent as empty tags (the API rejects those). */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

/** Up to 2 decimals and within the numeric(12,2) range — the client half of `priceSchema`. */
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/;
const STOCK_PATTERN = /^\d+$/;

/**
 * Client mirror of `createProductSchema` (catalog.dto.ts). Messages come from
 * the dictionary, so the schema is built per-render rather than defined at
 * module scope — the same approach the auth forms use.
 */
export function productFormSchema(t: Dictionary) {
  const optionalText = (max: number) =>
    z.string().trim().max(max, t.catalog.errorTooLong);

  return z.object({
    name: z
      .string()
      .trim()
      .min(1, t.catalog.errorNameRequired)
      .max(MAX_NAME_LENGTH, t.catalog.errorTooLong),
    nameAr: optionalText(MAX_NAME_LENGTH),
    sku: optionalText(MAX_SKU_LENGTH),
    description: optionalText(MAX_DESCRIPTION_LENGTH),
    descriptionAr: optionalText(MAX_DESCRIPTION_LENGTH),
    price: z
      .string()
      .trim()
      .min(1, t.catalog.errorPriceRequired)
      .regex(PRICE_PATTERN, t.catalog.errorPriceFormat)
      .refine((value) => Number(value) <= MAX_PRICE, t.catalog.errorPriceRange),
    currency: z.enum(CURRENCIES),
    stock: z
      .string()
      .trim()
      .min(1, t.catalog.errorStockRequired)
      .regex(STOCK_PATTERN, t.catalog.errorStockFormat)
      .refine((value) => Number(value) <= MAX_STOCK, t.catalog.errorStockRange),
    stockStatus: z.enum(STOCK_STATUSES),
    category: optionalText(MAX_CATEGORY_LENGTH),
    tags: z
      .string()
      .refine(
        (raw) => parseTags(raw).length <= MAX_TAGS,
        t.catalog.errorTooManyTags,
      )
      .refine(
        (raw) => parseTags(raw).every((tag) => tag.length <= MAX_TAG_LENGTH),
        t.catalog.errorTagTooLong,
      ),
    imageUrl: z
      .string()
      .trim()
      .max(MAX_IMAGE_URL_LENGTH, t.catalog.errorTooLong)
      .refine(
        (value) => value === "" || isHttpUrl(value),
        t.catalog.errorImageUrl,
      ),
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Optional text fields are omitted when blank — the API rejects `null` and would otherwise store `""`. */
function omitBlank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function toCreateInput(values: ProductFormValues): CreateProductInput {
  return {
    name: values.name.trim(),
    nameAr: omitBlank(values.nameAr),
    sku: omitBlank(values.sku),
    description: omitBlank(values.description),
    descriptionAr: omitBlank(values.descriptionAr),
    price: Number(values.price),
    currency: values.currency,
    stock: Number(values.stock),
    stockStatus: values.stockStatus,
    category: omitBlank(values.category),
    tags: parseTags(values.tags),
    imageUrl: omitBlank(values.imageUrl),
  };
}

/**
 * Diff against the loaded product: PATCH carries only what actually changed.
 * An empty result means "nothing to save" and the caller must NOT send it —
 * `updateProductSchema` 400s on an empty body by design.
 *
 * Clearing an optional text field sends `""` rather than omitting it: the
 * schema has no `null`, so an empty string is the only way to blank a value.
 */
export function toUpdateInput(
  values: ProductFormValues,
  original: ProductRecord,
): UpdateProductInput {
  const before = productToForm(original);
  const patch: UpdateProductInput = {};

  if (values.name.trim() !== before.name.trim())
    patch.name = values.name.trim();
  if (Number(values.price) !== Number(before.price))
    patch.price = Number(values.price);
  // An untracked (null) stock loads as "": Number("") is 0, so compare it as text.
  const stockChanged =
    before.stock === ""
      ? values.stock.trim() !== ""
      : Number(values.stock) !== Number(before.stock);
  if (stockChanged) patch.stock = Number(values.stock);
  if (values.currency !== before.currency) patch.currency = values.currency;
  if (values.stockStatus !== before.stockStatus)
    patch.stockStatus = values.stockStatus;

  const texts = [
    "nameAr",
    "sku",
    "description",
    "descriptionAr",
    "category",
    "imageUrl",
  ] as const;
  for (const key of texts) {
    const next = values[key].trim();
    if (next !== before[key].trim()) patch[key] = next;
  }

  const nextTags = parseTags(values.tags);
  const prevTags = parseTags(before.tags);
  if (
    nextTags.length !== prevTags.length ||
    nextTags.some((tag, i) => tag !== prevTags[i])
  ) {
    patch.tags = nextTags;
  }

  return patch;
}
