import { dateRangeQuerySchema } from './metrics.dto.zod';

describe('dateRangeQuerySchema', () => {
  it('accepts a valid range where from <= to', () => {
    const result = dateRangeQuerySchema.safeParse({
      from: '2026-08-01',
      to: '2026-08-31',
    });

    expect(result.success).toBe(true);
  });

  it('accepts an equal from/to (a single-instant range)', () => {
    const result = dateRangeQuerySchema.safeParse({
      from: '2026-08-01',
      to: '2026-08-01',
    });

    expect(result.success).toBe(true);
  });

  it('rejects a range where from is after to', () => {
    const result = dateRangeQuerySchema.safeParse({
      from: '2026-08-31',
      to: '2026-08-01',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-date value', () => {
    const result = dateRangeQuerySchema.safeParse({
      from: 'not-a-date',
      to: '2026-08-31',
    });

    expect(result.success).toBe(false);
  });
});
