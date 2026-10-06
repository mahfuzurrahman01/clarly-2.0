// F25 D9: shape, and no ambiguous characters. A merchant reads this down a
// phone line.
import {
  generateOrderReference,
  isOrderReference,
  REFERENCE_ALPHABET,
  REFERENCE_BODY_LENGTH,
  REFERENCE_PREFIX,
} from './order-reference';

describe('order-reference', () => {
  it('produces ORD- plus six characters', () => {
    const reference = generateOrderReference();
    expect(reference).toMatch(/^ORD-[A-Z0-9]{6}$/);
    expect(reference.length).toBe(
      REFERENCE_PREFIX.length + REFERENCE_BODY_LENGTH,
    );
  });

  it('never emits an ambiguous glyph (I, L, O, U, 0, 1)', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(REFERENCE_ALPHABET).not.toContain(ambiguous);
    }

    const body = Array.from({ length: 500 }, () =>
      generateOrderReference().slice(REFERENCE_PREFIX.length),
    ).join('');
    expect(body).not.toMatch(/[ILOU01]/);
  });

  it('draws from the whole alphabet rather than a constant', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) {
      for (const char of generateOrderReference().slice(
        REFERENCE_PREFIX.length,
      )) {
        seen.add(char);
      }
    }
    expect(seen.size).toBe(REFERENCE_ALPHABET.length);
  });

  it('does not repeat itself across a realistic batch (uniqueness is still the DB constraint)', () => {
    const references = new Set(
      Array.from({ length: 1_000 }, () => generateOrderReference()),
    );
    // A handful of collisions across 1e3 draws from ~1e9 would be
    // astronomically unlikely; anything below 999 means the generator is not
    // drawing independently.
    expect(references.size).toBeGreaterThanOrEqual(999);
  });

  it('recognises its own output and rejects everything else', () => {
    expect(isOrderReference(generateOrderReference())).toBe(true);
    expect(isOrderReference('ORD-ABCDE')).toBe(false); // too short
    expect(isOrderReference('ORD-ABCDEFG')).toBe(false); // too long
    expect(isOrderReference('ORD-ABC0EF')).toBe(false); // ambiguous glyph
    expect(isOrderReference('ORD-abcdef')).toBe(false); // lower case
    expect(isOrderReference('XYZ-ABCDEF')).toBe(false); // wrong prefix
    expect(isOrderReference('')).toBe(false);
  });
});
