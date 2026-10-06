// Feature 20 (Product Catalog & Stock): the search expressions are the one
// place where a silent, test-invisible regression is possible — Postgres only
// uses an expression index when the query's parse tree matches the index's,
// so a reordered `coalesce(...)` here keeps every behavioural test green while
// turning the catalog back into a sequential scan.
//
// These tests therefore render the fragments through PgDialect and assert the
// literal SQL, pinned against migrations 0053 (full text) and 0057 (trigram).
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  PRODUCT_TRGM_SIMILARITY_THRESHOLD,
  PRODUCT_TRGM_WORD_SIMILARITY_THRESHOLD,
  escapeLikeTerm,
  productFuzzyMatch,
  productFuzzyRank,
  productSearchDocument,
  productSearchTerms,
  productSearchTokens,
  productSearchQuery,
  productSearchVector,
  productTrigramThresholdStatement,
} from './catalog-search';

const dialect = new PgDialect();

function render(fragment: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment);
  return { sql: query.sql, params: query.params };
}

/** The document as migration 0053/0057 spell it, whitespace-normalised. */
const EXPECTED_DOCUMENT =
  `(coalesce("products"."name", '') || ' ' || coalesce("products"."name_ar", '') || ' ' ` +
  `|| coalesce("products"."sku", '') || ' ' || coalesce("products"."category", '') || ' ' ` +
  `|| coalesce("products"."description", '') || ' ' || coalesce("products"."description_ar", ''))`;

describe('catalog-search expressions', () => {
  it('builds the exact document the GIN indexes are defined on', () => {
    expect(render(productSearchDocument).sql).toBe(EXPECTED_DOCUMENT);
  });

  it('indexes with the `simple` config, never a stemmer that mangles Arabic', () => {
    expect(render(productSearchVector).sql).toBe(
      `to_tsvector('simple', ${EXPECTED_DOCUMENT})`,
    );
  });

  it('parameterises the full-text term rather than interpolating it', () => {
    const { sql, params } = render(productSearchQuery("mouse';--"));
    expect(sql).toBe("plainto_tsquery('simple', $1)");
    expect(params).toEqual(["mouse';--"]);
  });

  describe('tolerant (OR) full-text query', () => {
    it('tokenises on whitespace and drops filler words', () => {
      expect(
        productSearchTokens('grey electric kettle small fast boil'),
      ).toEqual(['grey', 'electric', 'kettle', 'small', 'fast', 'boil']);
      expect(productSearchTokens('the Bosch  hand blender')).toEqual([
        'bosch',
        'hand',
        'blender',
      ]);
      expect(productSearchTokens('قلاية زينث الهوائية')).toEqual([
        'قلاية',
        'زينث',
        'الهوائية',
      ]);
    });

    it('falls back to the whole term when every token is filler', () => {
      expect(productSearchTokens('the')).toEqual(['the']);
    });

    it('ORs one parameterised plainto_tsquery per token, never interpolating', () => {
      const { sql, params } = render(productSearchQuery("Bosch blender';--"));
      expect(sql).toBe(
        "(plainto_tsquery('simple', $1) || plainto_tsquery('simple', $2))",
      );
      expect(params).toEqual(['bosch', "blender';--"]);
    });

    it('caps the token count so a pasted paragraph cannot build a giant query', () => {
      const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
      expect(productSearchTokens(many)).toHaveLength(8);
    });
  });

  describe('Arabic article and category normalisation', () => {
    it('finds "قلاية هوائية" from "القلاية الهوائية" (commerce-journey#6)', () => {
      const terms = productSearchTerms('القلاية الهوائية');
      expect(terms).toEqual(
        expect.arrayContaining(['القلاية', 'الهوائية', 'قلاية', 'هوائية']),
      );
      const { sql, params } = render(productSearchQuery('القلاية الهوائية'));
      expect(sql).toContain("plainto_tsquery('simple', $1)");
      expect(params).toEqual(expect.arrayContaining(['قلاية', 'هوائية']));
    });

    it('searches the English category for an Arabic category query (commerce-lookup#13)', () => {
      expect(productSearchTerms('أدوات المطبخ')).toEqual(
        expect.arrayContaining(['مطبخ', 'kitchen']),
      );
      expect(productSearchTerms('مطبخ')).toContain('kitchen');
    });

    it('feeds the stripped stems to the trigram pass too', () => {
      const { params } = render(productFuzzyMatch('القلاية الهوائية'));
      expect(params).toEqual(expect.arrayContaining(['قلاية', 'هوائية']));
    });

    it('does not add category terms to an ordinary product query', () => {
      const terms = productSearchTerms('غلاية كورال');
      expect(terms).toEqual(expect.arrayContaining(['غلاية', 'كورال']));
      expect(terms).not.toContain('kitchen');
      expect(productSearchTerms('Bosch hand blender')).toEqual([
        'bosch',
        'hand',
        'blender',
      ]);
    });

    it('caps the expanded term list', () => {
      const many = Array.from({ length: 8 }, (_, i) => `الكلمة${i}`).join(' ');
      expect(productSearchTerms(many).length).toBeLessThanOrEqual(24);
    });
  });

  describe('trigram fuzzy matching', () => {
    it('matches with `%` and the token-level `<%`, the operators the GIN trigram index serves', () => {
      const { sql, params } = render(productFuzzyMatch('wirless mouse'));
      // `similarity(...) > 0.3` would be correct and unindexed; `%`/`<%` are
      // the operators gin_trgm_ops actually supports.
      expect(sql).toBe(
        `(${EXPECTED_DOCUMENT} % $1 or $2 <% ${EXPECTED_DOCUMENT} or $3 <% ${EXPECTED_DOCUMENT})`,
      );
      expect(params).toEqual(['wirless mouse', 'wirless', 'mouse']);
    });

    it('lets a word-order variant match at token level', () => {
      const { sql, params } = render(productFuzzyMatch('برادة ماء'));
      expect(sql).toContain('<%');
      expect(params).toContain('ماء');
    });

    it('ranks the fuzzy pass by similarity against the same document', () => {
      const { sql, params } = render(productFuzzyRank('wirless mouse'));
      expect(sql).toBe(
        `greatest(similarity(${EXPECTED_DOCUMENT}, $1), word_similarity($2, ${EXPECTED_DOCUMENT}), word_similarity($3, ${EXPECTED_DOCUMENT}))`,
      );
      expect(params).toEqual(['wirless mouse', 'wirless', 'mouse']);
    });

    it('pins the threshold transaction-locally instead of trusting server config', () => {
      const { sql, params } = render(productTrigramThresholdStatement);
      expect(sql).toBe(
        "select set_config('pg_trgm.similarity_threshold', $1, true), set_config('pg_trgm.word_similarity_threshold', $2, true)",
      );
      // `true` = is_local: reverted at commit, so one tenant's search can
      // never leave a loosened threshold behind on a pooled connection.
      expect(params).toEqual([
        String(PRODUCT_TRGM_SIMILARITY_THRESHOLD),
        String(PRODUCT_TRGM_WORD_SIMILARITY_THRESHOLD),
      ]);
    });

    it('keeps the threshold strict enough that a two-letter term cannot match everything', () => {
      expect(PRODUCT_TRGM_SIMILARITY_THRESHOLD).toBeGreaterThanOrEqual(0.3);
      expect(PRODUCT_TRGM_SIMILARITY_THRESHOLD).toBeLessThan(1);
    });
  });

  describe('escapeLikeTerm', () => {
    it('neutralises the wildcards that would dump a whole price list', () => {
      expect(escapeLikeTerm('%')).toBe('\\%');
      expect(escapeLikeTerm('_')).toBe('\\_');
      expect(escapeLikeTerm('100%_off')).toBe('100\\%\\_off');
    });

    it('escapes the escape character itself', () => {
      expect(escapeLikeTerm('a\\b')).toBe('a\\\\b');
    });
  });
});
