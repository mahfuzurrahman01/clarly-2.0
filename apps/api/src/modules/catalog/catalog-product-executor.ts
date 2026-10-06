// Feature 20 (Product Catalog & Stock): executes the lookup_product tool.
// Called by ToolExecutionService after authorization.
//
// D5 (anti-hallucination) is enforced in the two places that survive a
// prompt-injection attempt: the tool's own description (see
// catalog-product.tool.ts, which is what L3 shows the model) and the
// `guidance` field on every result payload below. Prompt text alone is not a
// guardrail (D12), but the model cannot invent a price it was never handed —
// the payload carries ONLY catalog columns, never free text from the
// customer's message or an image caption, and a zero-result lookup says so
// explicitly rather than returning an empty object the model can fill in.
import { Injectable } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import type { LookupProductInput } from './catalog-product.tool';
import { canonicalCategory } from './catalog-query-normalization';
import { isApiHostedProductImageUrl } from './product-image';
// Type-only import, same direction as the `ToolDefinition` type this module
// already imports back from tool-execution: no runtime cycle.
import type { ToolExecutionContext } from '../tool-execution/tool-execution-context';

export interface ProductLookupResult {
  products: Array<{
    id: string;
    name: string;
    nameAr: string | null;
    sku: string | null;
    price: string;
    currency: string;
    /** Null when the shop does not count this product's stock. */
    stock: number | null;
    stockStatus: string;
    imageUrl: string | null;
    category: string | null;
  }>;
  message?: string;
  /** D5: travels with the results so the instruction is adjacent to the data it constrains. */
  guidance: string;
}

export const LOOKUP_PRODUCT_MATCH_GUIDANCE =
  'These rows are the only source of price and stock you may use. Quote the price, currency and stock status exactly as given here, and name the product you matched. Never adjust, convert, round or estimate a price, never infer stock from anything but stock_status, and never describe a product that is not listed here. A null stock means the shop does not count that product: never state a quantity for it. If none of these rows is the product the customer means, treat it as no match.';

export const LOOKUP_PRODUCT_NO_MATCH_GUIDANCE =
  'No catalog row matched. You do not know this product\'s price or availability yet. If you have not already retried, call lookup_product ONCE more with a shorter query: just the core product noun (for example "kettle" or "غلاية"), dropping brand, size, colour and other modifiers. If that retry also returns no rows, do not guess, do not quote a price from the conversation, an image caption, or the knowledge base, and do not describe the product as available or unavailable. Tell the customer you need to check with the team and escalate.';

@Injectable()
export class CatalogProductExecutor {
  constructor(private readonly catalog: CatalogService) {}

  /**
   * `ctx` carries the whole turn identity (tenant, conversation, customer,
   * turn). The catalog is tenant-wide, so this executor reads `ctx.tenantId`
   * and nothing else — deliberately: scoping a product lookup to the asking
   * customer would be wrong, and reading a field it does not need would make
   * the tool's blast radius larger than its job.
   */
  async execute(
    ctx: ToolExecutionContext,
    args: LookupProductInput,
  ): Promise<ProductLookupResult> {
    const products = await this.catalog.searchProducts(
      ctx.tenantId,
      args.query,
      {
        limit: args.limit ?? 5,
        // Advertised in the tool schema, so it has to actually filter — an
        // arg the model is told exists but that the executor drops is worse
        // than no arg at all: the model believes it narrowed the search.
        // The model may pass the customer's own word ("المطبخ", "matbakh");
        // catalog categories are slugs, so an Arabic/Arabizi category word
        // is mapped to its slug. Unknown values pass through untouched.
        category: args.category ? canonicalCategory(args.category) : undefined,
      },
    );

    if (products.length === 0) {
      return {
        products: [],
        message: 'No matching products found',
        guidance: LOOKUP_PRODUCT_NO_MATCH_GUIDANCE,
      };
    }

    return {
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        nameAr: p.nameAr,
        sku: p.sku,
        price: p.price,
        currency: p.currency,
        stock: p.stock,
        stockStatus: p.stockStatus,
        // A console-uploaded photo lives behind this API's own
        // bearer-authenticated image route (see product-image.ts): handing
        // that address to the model means it can paste a link into a
        // WhatsApp reply that 401s for the customer. A store-synced
        // `image_url` is a public merchant CDN address and passes through
        // untouched.
        imageUrl:
          p.imageUrl && isApiHostedProductImageUrl(p.imageUrl)
            ? null
            : p.imageUrl,
        category: p.category,
      })),
      guidance: LOOKUP_PRODUCT_MATCH_GUIDANCE,
    };
  }
}
