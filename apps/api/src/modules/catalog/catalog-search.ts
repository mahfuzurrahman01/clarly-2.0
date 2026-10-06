// Feature 20 (Product Catalog & Stock): the one definition of "what text a
// product is searchable by".
//
// This expression MUST stay character-for-character equivalent to the
// expression BOTH GIN indexes are built on — the full-text one from migration
// 0053_catalog-search-and-tool-seed and the trigram one from
// 0057_catalog-trgm. Postgres only uses an expression index when the query's
// expression matches the index's parse tree; a drifted `coalesce(...)`
// ordering here silently turns every catalog lookup back into a sequential
// scan, which is exactly the failure mode this file exists to prevent.
//
// `simple` (not `english`) is deliberate: Gulf merchants mix Arabic and
// English in one catalog, and the english stemmer mangles Arabic tokens
// while adding nothing for SKUs like `WM-001`.
import { sql, type SQL } from 'drizzle-orm';
import { products } from '../persistence/drizzle/schema';
import {
  categoryTermsForToken,
  normalizedTokenVariants,
} from './catalog-query-normalization';

export const PRODUCT_SEARCH_TEXT_CONFIG = 'simple';

/** The concatenated searchable document for a product row. */
export const productSearchDocument: SQL = sql`(coalesce(${products.name}, '') || ' ' || coalesce(${products.nameAr}, '') || ' ' || coalesce(${products.sku}, '') || ' ' || coalesce(${products.category}, '') || ' ' || coalesce(${products.description}, '') || ' ' || coalesce(${products.descriptionAr}, ''))`;

/** `to_tsvector` over that document — the indexed expression. */
export const productSearchVector: SQL = sql`to_tsvector('simple', ${productSearchDocument})`;

const MAX_SEARCH_TOKENS = 8;
/** Ceiling on the expanded (variant + category) term list, so the OR-ed query stays small. */
const MAX_SEARCH_TERMS = 24;
/** Words that match half the catalog and say nothing about which product is meant. */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'for',
  'and',
  'or',
  'with',
  'in',
  'to',
  'is',
  'do',
  'you',
  'have',
  'any',
  'من',
  'في',
  'و',
  'عن',
  'على',
  'هل',
  'عندكم',
]);

/**
 * Whitespace tokens of a raw agent/customer query, lower-cased, minus filler
 * and capped. Falls back to the whole term when nothing survives, so a query
 * like "the" still runs rather than silently returning nothing.
 */
export function productSearchTokens(term: string): string[] {
  const all = term.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = all.filter((token) => !FILLER_TOKENS.has(token));
  const tokens = (kept.length ? kept : all).slice(0, MAX_SEARCH_TOKENS);
  return tokens.length ? tokens : [term.trim().toLowerCase()];
}

/**
 * {@link productSearchTokens} expanded for Arabic/Arabizi: each token also
 * contributes its article/clitic-stripped stems ("القلاية" -> "قلاية") and
 * hamza/ta-marbuta spellings, and a category word also contributes the English
 * category it names ("مطبخ" -> "kitchen", because the searchable document
 * holds the English category column). Raw tokens come first and English-only
 * queries pass through unchanged.
 */
export function productSearchTerms(term: string): string[] {
  const terms = new Set<string>();
  for (const token of productSearchTokens(term)) {
    for (const variant of normalizedTokenVariants(token)) {
      terms.add(variant);
      for (const category of categoryTermsForToken(variant)) {
        terms.add(category);
      }
    }
  }
  return [...terms].slice(0, MAX_SEARCH_TERMS);
}

/**
 * Tolerant full-text query: one `plainto_tsquery` per token, OR-ed with `||`.
 * `plainto_tsquery` ANDs terms, so a single extra or absent word ("small",
 * "Bosch hand blender" vs "Bosch Hand Mixer") used to return zero rows; OR-ing
 * lets `ts_rank` order rows by how many query terms they match instead, so an
 * exact name or SKU still ranks first. Every token stays a bound parameter and
 * `plainto_tsquery` never throws on punctuation, unlike `to_tsquery`.
 */
export function productSearchQuery(term: string): SQL {
  const parts = productSearchTerms(term).map(
    (token) => sql`plainto_tsquery('simple', ${token})`,
  );
  return parts.length === 1 ? parts[0] : sql`(${sql.join(parts, sql` || `)})`;
}

/**
 * pg_trgm's match threshold for the fuzzy pass, pinned per transaction rather
 * than inherited from the server (Postgres' default is 0.3, but a deployment
 * that has tuned `pg_trgm.similarity_threshold` for some other workload must
 * not be able to widen or narrow catalog search as a side effect).
 *
 * 0.3 is deliberately not lower: below it, a short term shares enough
 * trigrams with nearly every row that the "fuzzy" pass degenerates into
 * "return the catalog", which is the same exfiltration shape `escapeLikeTerm`
 * exists to prevent.
 */
export const PRODUCT_TRGM_SIMILARITY_THRESHOLD = 0.3;

/**
 * Threshold for the token-level `<%` operator (word_similarity). Postgres'
 * default is 0.6; pinned for the same reason as the one above.
 */
export const PRODUCT_TRGM_WORD_SIMILARITY_THRESHOLD = 0.6;

/**
 * Sets both thresholds transaction-locally (`set_config(..., is_local =>
 * true)`), so they are reverted at commit and never leak onto the next
 * tenant's query over a pooled connection.
 */
export const productTrigramThresholdStatement: SQL = sql`select set_config('pg_trgm.similarity_threshold', ${String(PRODUCT_TRGM_SIMILARITY_THRESHOLD)}, true), set_config('pg_trgm.word_similarity_threshold', ${String(PRODUCT_TRGM_WORD_SIMILARITY_THRESHOLD)}, true)`;

/** Tokens worth a token-level trigram probe: 3+ chars, or the noise floor swamps the ranking. */
function fuzzyTokens(term: string): string[] {
  return productSearchTerms(term).filter((token) => token.length >= 3);
}

/**
 * Fuzzy predicate for a misspelled, partial or re-ordered term — `photo -> product ->
 * price` has to survive "wirless mous".
 *
 * `%` and `<%` (not `similarity(...) > threshold`) are the operators
 * `gin_trgm_ops` indexes: the function form is correct and unindexed, which on a real
 * catalog means a sequential scan per agent turn. A wildcard term is
 * harmless here without escaping — `%` and `_` carry no trigrams, so they
 * match nothing rather than everything — but the substring pass that runs
 * alongside this one still escapes, see {@link escapeLikeTerm}.
 */
export function productFuzzyMatch(term: string): SQL {
  const tokenMatches = fuzzyTokens(term).map(
    (token) => sql`${token} <% ${productSearchDocument}`,
  );
  return sql`(${sql.join(
    [sql`${productSearchDocument} % ${term}`, ...tokenMatches],
    sql` or `,
  )})`;
}

/**
 * Ordering key for the fuzzy pass: closest spelling first, whether by the
 * whole string or by the best single token (word-order variants such as
 * "قلاية زينث الهوائية" vs "قلاية هوائية زينث 5 لتر" only match per token).
 */
export function productFuzzyRank(term: string): SQL {
  const tokenRanks = fuzzyTokens(term).map(
    (token) => sql`word_similarity(${token}, ${productSearchDocument})`,
  );
  return sql`greatest(${sql.join(
    [sql`similarity(${productSearchDocument}, ${term})`, ...tokenRanks],
    sql`, `,
  )})`;
}

/**
 * Escapes LIKE wildcards in a user-supplied term.
 *
 * Without this, a query of `%` matches the entire catalog and a query of `_`
 * matches every single-character value — an agent (or an injected KB
 * document) could dump a tenant's whole price list in one tool call.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}
