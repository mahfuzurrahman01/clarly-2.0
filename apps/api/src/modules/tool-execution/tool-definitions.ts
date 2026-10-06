// Agent (AI-owned, T2/A2): the single source of truth for a tool's argument
// shape. AI_PIPELINE_PLAN.md requires "arg schemas are Zod, shared with
// ToolExecutionModule so prompt-visible and execution-validated schema are
// the same object" — `zodSchema` here is what THIS module validates
// against; `jsonSchema` is hand-authored to match it and is what gets
// written into a tenant_tools row (tool-registry) for L3 to show the model.
// Keeping both fields on one object literal, instead of deriving one from
// the other at runtime, keeps the "same object" property honest without
// pulling in a zod-to-json-schema dependency for a single scaffold tool.
//
// `echo` is a scaffold, not a real product tool — it exists to prove the
// authorize() -> validate -> execute mechanism end-to-end, and predates the
// real tools below.
//
// The two real tools own their definitions in their feature modules and are
// only REGISTERED here, so the tool's schema, its executor and its D5
// guidance text stay in one place. The import direction is
// tool-execution -> feature module; the feature modules import only the
// `ToolDefinition` *type* back, so there is no runtime cycle.
//
// Registration is not the same as availability: a tool is callable only when
// the tenant has a `tenant_tools` row for it (ToolExecutionService.authorize).
// `lookup_product` gets one at signup (CatalogToolSeederService) and via
// migration 0053's backfill. `create_order` deliberately gets NONE yet — it
// places real, paid orders, and F25 (GULF_PARITY_PLAN Phase 7) owns the
// per-tenant opt-in and human-approval mode that must gate it. Until that
// ships, every create_order call correctly fails ToolScopeViolation.
import { z } from 'zod';
import { lookupProductToolDefinition } from '../catalog/catalog-product.tool';
import { createOrderToolDefinition } from '../order/create-order.tool';
import { trackOrderToolDefinition } from '../courier/track-order.tool';
import {
  bookAppointmentToolDefinition,
  checkAvailabilityToolDefinition,
} from '../booking/booking-tools';

export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  zodSchema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
}

const echoArgsSchema = z.object({
  message: z.string().min(1).max(500),
});

export const TOOL_DEFINITIONS: Readonly<Record<string, ToolDefinition>> = {
  echo: {
    name: 'echo',
    description:
      'Scaffold tool (Feature 1) — echoes the provided message back. Not a real product tool.',
    zodSchema: echoArgsSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  lookup_product: lookupProductToolDefinition,
  create_order: createOrderToolDefinition,
  // F26 (D4). Unlike `create_order`, this one IS seeded enabled for every
  // tenant — it is read-only, customer-scoped, and moves no money, so it
  // needs no approval gate. `CourierToolSeederService` writes the row at
  // signup and migration 0060 backfills existing tenants.
  track_order: trackOrderToolDefinition,
  // Clarly 2.0 S2 (bookings). Enabled per tenant only while the booking mode
  // is not `disabled` (BookingToolSeederService), and the executors re-check
  // the mode at execution time.
  check_availability: checkAvailabilityToolDefinition,
  book_appointment: bookAppointmentToolDefinition,
};
