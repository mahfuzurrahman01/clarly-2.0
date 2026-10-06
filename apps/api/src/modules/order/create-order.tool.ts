// F25 D8: MOVED from `store/create-order.tool.ts`.
//
// The tool now belongs to the module that owns the order, not to the module
// that owns the store connection: F25's D4 makes Clarly's `orders` table
// authoritative and the store push a separate asynchronous step, so the tool's
// schema, its executor and its description live together in `order/`.
//
// Registration is not availability. `create_order` reaches a tenant's L3 only
// when `OrderToolSeederService` has written the `tenant_tools` row, which it
// does only while `tenant_order_settings.mode` is `human_approval` or `auto`
// (D1.2 gate 1). A tenant that has not opted in cannot have an order created
// by the agent under any prompt, because the model is never told the tool
// exists.
//
// Field naming note: the wire names (`customerName`, `customerPhone`,
// `shippingAddress`) are kept verbatim from F24's shipped schema so a model
// prompt-tuned against it does not have to be re-tuned; they map onto the
// row's `contact_*` / `address` columns, which are named for what they are —
// untrusted display/delivery data the agent collected, never identity (D2.2).
import { z } from 'zod';
import type { ToolDefinition } from '../tool-execution/tool-definitions';

export const CreateOrderInput = z.object({
  customerName: z.string().min(1).max(200),
  customerPhone: z.string().min(5).max(20),
  shippingAddress: z.string().min(5).max(500),
  city: z.string().max(100).optional(),
  items: z
    .array(
      z.object({
        // A catalog row id (F20 `products.id`), as returned by lookup_product
        // — not a store-side external id. The executor resolves it against
        // the tenant's OWN catalog inside the write transaction, and a uuid
        // shape is what makes that lookup safe to run.
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
        // Optional, and only when the customer named a colour / size / model
        // option: catalogue variants are separate rows, so the executor checks
        // the chosen row actually carries it (a "red" request cannot be
        // written as the plain model).
        variant: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(20),
  notes: z.string().max(500).optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderInput>;

export const createOrderToolDefinition: ToolDefinition<CreateOrderInput> = {
  name: 'create_order',
  description:
    'Record an order for the customer you are talking to. Use only when the customer has confirmed what they want to buy AND has themselves given you their name, phone number and delivery address. Never invent, guess or use placeholder values (such as "Customer", "N/A", "Not provided yet", "unknown", "same") for customerName, customerPhone or shippingAddress: if any is missing, ask the customer for it first and do not call this tool until you have it. A result with status "refused" and missingFields means no order was created: ask the customer for those fields. Call lookup_product first and copy each productId from the matching row of its result; never invent one, never call this tool with empty or partial arguments, and never take a price from the customer — the price charged is always the catalogue price. If the customer named a colour, size or model option, put it in the variant field of that item and order the row for that option, never the plain model; if no such row exists or it is out of stock, do not order it. Use the quantity the customer last stated: if they changed it during the conversation ("make it 2"), the final number wins, not the first. A result with customerMessage "lookup_product_then_retry" means no order was created: call lookup_product and retry with the right row, or tell the customer the option is unavailable. Payment is cash on delivery. This tool does NOT confirm the order to the customer by itself: read the `customerMessage` field in the result and follow it exactly. If the result says the order is awaiting the team, tell the customer it has been recorded and the team will confirm — never that it is placed, confirmed, paid or shipped.',
  zodSchema: CreateOrderInput,
  jsonSchema: {
    type: 'object',
    properties: {
      customerName: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description:
          'Full name exactly as the customer gave it. Ask if not given; never a placeholder',
      },
      customerPhone: {
        type: 'string',
        minLength: 5,
        maxLength: 20,
        description:
          'Contact phone number the customer gave. Ask if not given; never a placeholder',
      },
      shippingAddress: {
        type: 'string',
        minLength: 5,
        maxLength: 500,
        description:
          "Delivery address in the customer's own words. Ask if not given; never a placeholder",
      },
      city: {
        type: 'string',
        maxLength: 100,
        description: 'Optional city, when the customer states it separately',
      },
      items: {
        type: 'object',
        properties: {},
        description: 'Products to order',
      },
      notes: {
        type: 'string',
        maxLength: 500,
        description: 'Optional order notes from the customer',
      },
    },
    required: ['customerName', 'customerPhone', 'shippingAddress', 'items'],
    additionalProperties: false,
  },
};

// The `items` array schema is spelled out separately and spliced in, because
// an inline nested array literal in the object above is easy to let drift from
// the Zod schema — the one thing A2's "same object" rule forbids.
(
  createOrderToolDefinition.jsonSchema.properties as Record<string, unknown>
).items = {
  type: 'array',
  minItems: 1,
  maxItems: 20,
  description: 'Products to order',
  items: {
    type: 'object',
    properties: {
      productId: {
        type: 'string',
        format: 'uuid',
        description: 'Catalog product ID from lookup_product',
      },
      quantity: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description:
          'The quantity the customer most recently stated, after any change of mind',
      },
      variant: {
        type: 'string',
        maxLength: 100,
        description:
          'Only when the customer named a colour, size or model option: that option as it appears in the chosen row name. Omit otherwise',
      },
    },
    required: ['productId', 'quantity'],
    additionalProperties: false,
  },
};
