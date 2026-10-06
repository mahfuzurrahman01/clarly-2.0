// F26 (Delivery Tracking): the `track_order` agent tool contract (D4).
//
// THE ARGUMENT LIST IS THE SECURITY BOUNDARY. There is deliberately no
// `customerPhone`, `customerId`, `customerName` or `tenantId` argument: any
// identity argument the model can fill is an identity argument a customer can
// talk the model into filling with someone else's value. "Check the order for
// +9665…" must not be answerable. The asking customer is derived from
// `ToolExecutionContext`, never from args, and `additionalProperties: false`
// plus Zod's default object stripping mean an injected identity field is
// never even read.
//
// The description carries D5's anti-hallucination contract, the same house
// pattern `lookup_product` uses: it ships in the tenant_tools row, so it
// reaches the model only when the tool is enabled and costs no PROMPT_VERSION
// bump.
import { z } from 'zod';
import type { ToolDefinition } from '../tool-execution/tool-definitions';

export const TrackOrderInput = z
  .object({
    orderReference: z.string().min(1).max(64).optional(),
    trackingNumber: z.string().min(4).max(64).optional(),
  })
  // `.strict()` rather than the default strip: an args object carrying
  // `customerPhone` is a prompt-injection attempt, and failing the call
  // (LLMMalformedToolCall) is a louder, more auditable outcome than silently
  // dropping the field.
  //
  // Cycle 3b (2026-10-04): both references are optional. A call with neither
  // returns the asking customer's own most recent shipments — the scope is
  // still `tenant_id AND customer_id` from execution context, so it reads
  // nothing a reference lookup could not. Requiring a reference made "where is
  // my order?" unanswerable without one: the model sent track_order({}),
  // it was rejected as malformed, and the turn ended LLM_ERROR
  // (commerce-complaint#8, 3/3) or skipped the tool (commerce-journey).
  .strict();

export type TrackOrderInput = z.infer<typeof TrackOrderInput>;

export const TRACK_ORDER_DESCRIPTION =
  "Look up the delivery status of the asking customer's own shipments. Call it FIRST, before you answer or escalate, whenever the customer asks where their order is, whether it has shipped or arrived, when it will arrive, or says it is late — in any language. Pass the order reference or courier tracking number when the customer or the conversation gave one; otherwise call it with no arguments, which returns this customer's own most recent shipments. Never ask the customer for a reference before trying. There is deliberately no way to ask about another person's order. Report only the status, location and estimated delivery date this tool returns: never estimate or promise a delivery date that is not in the result, never turn a status into a stronger claim than it makes, and if the tool returns no shipments, say you could not find one and escalate to the team rather than guessing.";

export const trackOrderToolDefinition: ToolDefinition<TrackOrderInput> = {
  name: 'track_order',
  description: TRACK_ORDER_DESCRIPTION,
  zodSchema: TrackOrderInput,
  jsonSchema: {
    type: 'object',
    properties: {
      orderReference: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        description: 'The order reference the customer quoted, e.g. "#1234"',
      },
      trackingNumber: {
        type: 'string',
        minLength: 4,
        maxLength: 64,
        description: 'The courier tracking number / AWB the customer quoted',
      },
    },
    additionalProperties: false,
  },
};
