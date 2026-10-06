// F25 D7: the HTTP request contract for the order surface.
//
// Every body and query string is Zod-parsed through `ZodValidationPipe`, the
// convention in `customer-label.controller.ts` and `kanban.dto.ts`. No bare TS
// interface on any write endpoint — that was F20's P1-2, and this feature
// touches money.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  ORDER_STATUSES,
  ORDER_STORE_SYNC_STATUSES,
} from '../persistence/drizzle/orders.table';
import {
  MAX_APPROVAL_WINDOW_HOURS,
  MIN_APPROVAL_WINDOW_HOURS,
  ORDER_MODES,
} from '../persistence/drizzle/tenant-order-settings.table';

export const DEFAULT_ORDER_PAGE_SIZE = 20;
export const MAX_ORDER_PAGE_SIZE = 100;
export const MAX_REJECTION_REASON_LENGTH = 500;

export const listOrdersQuerySchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    storeSyncStatus: z.enum(ORDER_STORE_SYNC_STATUSES).optional(),
    conversationId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    /** Opaque keyset cursor from a previous page's `nextCursor`. */
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_ORDER_PAGE_SIZE)
      .optional()
      .default(DEFAULT_ORDER_PAGE_SIZE),
  })
  .strict();

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export class ListOrdersQueryDto extends createZodDto(listOrdersQuerySchema) {}

export const rejectOrderBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(MAX_REJECTION_REASON_LENGTH),
  })
  .strict();

export type RejectOrderBody = z.infer<typeof rejectOrderBodySchema>;
export class RejectOrderBodyDto extends createZodDto(rejectOrderBodySchema) {}

/**
 * Every field optional, but not NO fields: an empty PATCH would otherwise
 * bump `updated_at` and return 200 having changed nothing — the same guard
 * `updateProductSchema` carries.
 */
export const updateOrderSettingsSchema = z
  .object({
    mode: z.enum(ORDER_MODES).optional(),
    codEnabled: z.boolean().optional(),
    approvalWindowHours: z
      .number()
      .int()
      .min(MIN_APPROVAL_WINDOW_HOURS)
      .max(MAX_APPROVAL_WINDOW_HOURS)
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field must be provided',
  });

export type UpdateOrderSettingsBody = z.infer<typeof updateOrderSettingsSchema>;
export class UpdateOrderSettingsBodyDto extends createZodDto(
  updateOrderSettingsSchema,
) {}

export interface OrderItemView {
  id: string;
  productId: string | null;
  productName: string;
  sku: string | null;
  unitPrice: string;
  currency: string;
  quantity: number;
  lineTotal: string;
  externalProductId: string | null;
  externalVariantId: string | null;
}

export interface OrderView {
  id: string;
  tenantId: string;
  reference: string;
  customerId: string;
  conversationId: string | null;
  status: string;
  contactName: string;
  contactPhone: string;
  city: string | null;
  address: string;
  notes: string | null;
  paymentMethod: string;
  paymentStatus: string;
  subtotal: string;
  total: string;
  currency: string;
  storeConnectionId: string | null;
  storeSyncStatus: string;
  externalOrderId: string | null;
  storeSyncAttempts: number;
  storeSyncError: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedReason: string | null;
  customerNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  items?: OrderItemView[];
}

export interface OrderPage {
  orders: OrderView[];
  /** Pass back as `cursor` for the next page. Null when this is the last page. */
  nextCursor: string | null;
}
