import { reciprocalRankFusion } from './rrf-fusion';

describe('reciprocalRankFusion()', () => {
  it('an item ranked first in both lists scores highest', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [{ id: 'a' }, { id: 'c' }, { id: 'b' }],
    ]);

    expect(fused[0]?.id).toBe('a');
  });

  it('an item appearing in both lists outranks one appearing in only one, even at a worse individual rank', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'only-in-vector' }, { id: 'both' }],
      [{ id: 'both' }, { id: 'only-in-lexical' }],
    ]);

    const rank = (id: string) => fused.findIndex((item) => item.id === id);
    expect(rank('both')).toBeLessThan(rank('only-in-vector'));
    expect(rank('both')).toBeLessThan(rank('only-in-lexical'));
  });

  it('returns results sorted descending by fused score', () => {
    const fused = reciprocalRankFusion([
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    ]);

    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });

  it('handles an empty list input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });

  it('handles one empty ranked list alongside a non-empty one', () => {
    const fused = reciprocalRankFusion([[], [{ id: 'a' }]]);

    expect(fused).toHaveLength(1);
    expect(fused[0]?.id).toBe('a');
    expect(typeof fused[0]?.score).toBe('number');
  });

  it('deduplicates an id appearing in multiple lists into a single fused entry', () => {
    const fused = reciprocalRankFusion([[{ id: 'a' }], [{ id: 'a' }]]);

    expect(fused).toHaveLength(1);
  });
});
