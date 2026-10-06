// Feature 20 (Product Catalog & Stock): the HTTP request contract.
//
// Zod-first like every other request shape in this app (customer-label.dto.ts,
// kanban.dto.ts) — the app has no global ValidationPipe, so a controller that
// types its @Body() as a bare TS interface is accepting *anything* the caller
// sends. Every write endpoint here parses through `ZodValidationPipe`, which
// is what turns a bad body into a 400 with issue detail instead of a 500 (or,
// worse, a silently-written malformed row).
//
// `price` is a number on the wire and a `numeric(12,2)` in the column: it is
// parsed here (finite, >= 0, max 2 decimal places) rather than coerced
// downstream, because `parseFloat` fallbacks are exactly how "0.00 SAR" ends
// up quoted to a customer.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  CURRENCIES,
  STOCK_STATUSES,
} from '../persistence/drizzle/products.table';
import {
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION,
  isProductImageMimeType,
} from './product-image';

/** Guards both the numeric(12,2) column and "free product because parseFloat returned NaN". */
export const priceSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(9_999_999_999)
  .refine((value) => Number.isInteger(Math.round(value * 100)), {
    message: 'price supports at most 2 decimal places',
  });

export const stockSchema = z.number().int().nonnegative().max(1_000_000_000);

export const currencySchema = z.enum(CURRENCIES);
export const stockStatusSchema = z.enum(STOCK_STATUSES);

export const MAX_NAME_LENGTH = 300;
export const MAX_SKU_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 5_000;
export const MAX_CATEGORY_LENGTH = 100;
export const MAX_TAGS = 25;

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    nameAr: optionalText(MAX_NAME_LENGTH),
    sku: optionalText(MAX_SKU_LENGTH),
    description: optionalText(MAX_DESCRIPTION_LENGTH),
    descriptionAr: optionalText(MAX_DESCRIPTION_LENGTH),
    price: priceSchema,
    currency: currencySchema.optional(),
    stock: stockSchema.optional(),
    stockStatus: stockStatusSchema.optional(),
    imageUrl: z.string().url().max(2_000).optional(),
    imageObjectKey: optionalText(500),
    category: optionalText(MAX_CATEGORY_LENGTH),
    tags: z.array(z.string().trim().min(1).max(50)).max(MAX_TAGS).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type CreateProductBody = z.infer<typeof createProductSchema>;
export class CreateProductDto extends createZodDto(createProductSchema) {}

// Every field optional, but not *no* fields: an empty PATCH body would
// otherwise bump `updated_at` and return 200 while changing nothing.
export const updateProductSchema = createProductSchema
  .extend({
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    price: priceSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field must be provided',
  });

export type UpdateProductBody = z.infer<typeof updateProductSchema>;
export class UpdateProductDto extends createZodDto(updateProductSchema) {}

/** Query params arrive as strings; coerced here so the controller never hand-rolls parseInt. */
export const listProductsQuerySchema = z
  .object({
    category: optionalText(MAX_CATEGORY_LENGTH),
    stock_status: stockStatusSchema.optional(),
    search: optionalText(200),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .strip();

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const searchProductsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    category: optionalText(MAX_CATEGORY_LENGTH),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strip();

export type SearchProductsQuery = z.infer<typeof searchProductsQuerySchema>;

/**
 * Hard ceiling on a single import request. See CatalogImportService for why
 * this is a request-level limit rather than a paginated job: a synchronous
 * HTTP import of an unbounded paste is the most likely way this endpoint
 * takes the API down.
 */
export const MAX_IMPORT_CSV_BYTES = 2_000_000;

export const importCsvSchema = z
  .object({
    csv: z.string().min(1).max(MAX_IMPORT_CSV_BYTES),
  })
  .strict();

export type ImportCsvBody = z.infer<typeof importCsvSchema>;
export class ImportCsvDto extends createZodDto(importCsvSchema) {}

/**
 * The multipart `file` part of a product-image upload, validated with the
 * same Zod pipe every other request shape here goes through rather than a
 * hand-rolled `if (!file)` ladder.
 *
 * Multer has already buffered the part by the time this runs, so `size` is
 * a ceiling on what is kept, not on what is read — the transport-level cap
 * belongs in the reverse proxy, and this is the app-level one. The MIME
 * allowlist is only half the check: the bytes are verified against the
 * declared type in CatalogImageService, because a caller controls this
 * header and not the file's magic number.
 */
export const productImageUploadSchema = z
  .object(
    {
      originalname: z.string().trim().min(1).max(255),
      mimetype: z.string().refine(isProductImageMimeType, {
        message: `file must be one of ${PRODUCT_IMAGE_MIME_TYPES_DESCRIPTION}`,
      }),
      size: z.number().int().positive().max(MAX_PRODUCT_IMAGE_BYTES),
      buffer: z.instanceof(Buffer),
    },
    {
      required_error: 'file is required',
      invalid_type_error: 'file is required',
    },
  )
  // Multer adds fieldname/encoding/stream; this schema owns the four fields
  // it reads and has no opinion on the rest.
  .passthrough();

export type ProductImageUpload = z.infer<typeof productImageUploadSchema>;
