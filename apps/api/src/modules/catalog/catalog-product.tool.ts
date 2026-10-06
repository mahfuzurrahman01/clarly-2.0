// Feature 20 (Product Catalog & Stock): agent tool for product lookup.
// The agent uses this to resolve customer product photos/queries to catalog
// rows with live price/stock.
import { z } from 'zod';
import type { ToolDefinition } from '../tool-execution/tool-definitions';

export const LookupProductInput = z.object({
  query: z.string().min(1).max(200),
  category: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export type LookupProductInput = z.infer<typeof LookupProductInput>;

export const lookupProductToolDefinition: ToolDefinition<LookupProductInput> = {
  name: 'lookup_product',
  description:
    'Look up a product by name, SKU, or description. Use when the customer asks about a product, its price, or its availability — including after an image description, where the description is the query. Returns matching catalog rows with live price, currency, stock and image. ' +
    // D5 (F20-product-catalog.md): the anti-hallucination contract. It lives
    // in the tool DESCRIPTION rather than in L0 because it is tool-scoped
    // data (it ships in the tenant_tools row and only reaches the model when
    // this tool is enabled), so it costs no PROMPT_VERSION bump and no
    // re-eval of every tenant's prompt. Deterministic backup is in the
    // executor's result payload, not this sentence.
    "Price and stock may come ONLY from this tool's results: never state a price, currency or availability that is not in a returned row, and never carry one over from an image caption, the knowledge base, or an earlier turn. If the tool returns no products, say you need to check with the team and escalate rather than describing the product.",
  zodSchema: LookupProductInput,
  jsonSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Product name, SKU, or description to search for',
      },
      category: {
        type: 'string',
        maxLength: 100,
        description: 'Optional category filter',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 10,
        description: 'Max results (default 5)',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};
