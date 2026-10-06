// Cycle-3 evals (commerce-journey#6, commerce-lookup#13, gulf-arabic-*): the
// Arabic definite article and Arabic category words made real catalog rows
// unreachable. Every query below is a real failing tool call from those runs.
import {
  canonicalCategory,
  categoryMatchValues,
  categoryTermsForToken,
  normalizedTokenVariants,
} from './catalog-query-normalization';

describe('normalizedTokenVariants', () => {
  it('strips the definite article: القلاية -> قلاية (journey#6)', () => {
    expect(normalizedTokenVariants('القلاية')).toEqual(
      expect.arrayContaining(['القلاية', 'قلاية']),
    );
    expect(normalizedTokenVariants('الهوائية')).toEqual(
      expect.arrayContaining(['هوائية', 'هوائيه']),
    );
  });

  it('keeps the raw token first so a stored article-bearing spelling still matches', () => {
    expect(normalizedTokenVariants('الخلاط')[0]).toBe('الخلاط');
  });

  it.each([
    ['والخلاط', 'خلاط'],
    ['بالمطبخ', 'مطبخ'],
    ['للمطبخ', 'مطبخ'],
    ['فالغلاية', 'غلاية'],
    ['كالغلاية', 'غلاية'],
    ['لخلاط', 'خلاط'],
    ['وغلاية', 'غلاية'],
  ])('strips the clitic prefix: %s -> %s', (token, stem) => {
    expect(normalizedTokenVariants(token)).toContain(stem);
  });

  it('never strips a letter that belongs to the word: باريق keeps its own spelling', () => {
    expect(normalizedTokenVariants('باريق')[0]).toBe('باريق');
    // the bare-clitic stem is only an extra OR-ed variant, never a replacement
    expect(normalizedTokenVariants('بوش')).toEqual(['بوش']);
    expect(normalizedTokenVariants('لتر')).toEqual(['لتر']);
  });

  it('ignores harakat, tatweel and trailing punctuation', () => {
    expect(normalizedTokenVariants('الغَلّايَة؟')).toContain('غلاية');
  });

  it('adds hamza and ta-marbuta spellings of the stem', () => {
    expect(normalizedTokenVariants('الأكواب')).toEqual(
      expect.arrayContaining(['أكواب', 'اكواب']),
    );
    expect(normalizedTokenVariants('براده')).toContain('برادة');
  });

  it('strips the Arabizi article only with a separator', () => {
    expect(normalizedTokenVariants('al-mawad')).toContain('mawad');
    expect(normalizedTokenVariants('el-matbakh')).toContain('matbakh');
    expect(normalizedTokenVariants('alpha')).toEqual(['alpha']);
    expect(normalizedTokenVariants('elite')).toEqual(['elite']);
  });

  it('leaves English and SKU tokens untouched', () => {
    expect(normalizedTokenVariants('x200')).toEqual(['x200']);
    expect(normalizedTokenVariants('brq-afy-55')).toEqual(['brq-afy-55']);
  });
});

describe('category words', () => {
  it.each([
    ['أدوات المطبخ', 'kitchen'], // commerce-lookup#13
    ['مطبخ', 'kitchen'],
    ['المطبخ', 'kitchen'],
    ['للمطبخ', 'kitchen'],
    ['matbakh', 'kitchen'],
    ['el-matbakh', 'kitchen'],
    ['الإلكترونيات', 'electronics'],
    ['الالكترونيات', 'electronics'],
    ['أحذية', 'footwear'],
    ['عطور', 'fragrance'],
  ])('maps %s to %s', (word, slug) => {
    expect(canonicalCategory(word)).toBe(slug);
  });

  it("never rewrites a tenant's own category name", () => {
    expect(canonicalCategory('Electronics')).toBe('Electronics');
    expect(canonicalCategory('Pet Supplies')).toBe('Pet Supplies');
    expect(canonicalCategory('kitchen')).toBe('kitchen');
  });

  it('expands a token to the English category the document actually holds', () => {
    expect(categoryTermsForToken('مطبخ')).toContain('kitchen');
    expect(categoryTermsForToken('المطبخ')).toContain('kitchen');
    expect(categoryTermsForToken('غلاية')).toEqual([]);
    expect(categoryTermsForToken('باريق')).toEqual([]);
  });

  it('lists every stored spelling for a recognised category, null otherwise', () => {
    expect(categoryMatchValues('kitchen')).toEqual(
      expect.arrayContaining(['kitchen', 'kitchenware', 'مطبخ']),
    );
    expect(categoryMatchValues('Kitchen')).toEqual(
      categoryMatchValues('kitchen'),
    );
    expect(categoryMatchValues('أدوات المطبخ')).toContain('kitchen');
    expect(categoryMatchValues('Electronics')).toContain('electronics');
    expect(categoryMatchValues('Pet Supplies')).toBeNull();
  });
});
