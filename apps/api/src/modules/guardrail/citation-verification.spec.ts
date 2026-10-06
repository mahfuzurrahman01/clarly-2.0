import { verifyCitations } from './citation-verification';

describe('verifyCitations()', () => {
  it('D10: zero cited chunks -> hasZeroCitations true, allValid false', () => {
    const result = verifyCitations([], ['chunk-1', 'chunk-2']);

    expect(result.hasZeroCitations).toBe(true);
    expect(result.allValid).toBe(false);
    expect(result.fabricatedIds).toEqual([]);
  });

  it('all cited IDs present in the retrieved set -> allValid true', () => {
    const result = verifyCitations(['chunk-1'], ['chunk-1', 'chunk-2']);

    expect(result.allValid).toBe(true);
    expect(result.fabricatedIds).toEqual([]);
    expect(result.hasZeroCitations).toBe(false);
  });

  it('D10: a citation not in the retrieved set is fabrication -> allValid false, hallucination signal', () => {
    const result = verifyCitations(
      ['chunk-1', 'chunk-99'],
      ['chunk-1', 'chunk-2'],
    );

    expect(result.allValid).toBe(false);
    expect(result.fabricatedIds).toEqual(['chunk-99']);
  });

  it('every cited ID fabricated', () => {
    const result = verifyCitations(['chunk-99'], ['chunk-1']);

    expect(result.allValid).toBe(false);
    expect(result.fabricatedIds).toEqual(['chunk-99']);
  });
});
