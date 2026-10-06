import { chunkText } from './chunking';

describe('chunkText()', () => {
  it('returns a single chunk when content fits within chunkSize', () => {
    const chunks = chunkText('Short content.', {
      chunkSize: 1000,
      chunkOverlap: 100,
    });

    expect(chunks).toEqual(['Short content.']);
  });

  it('returns an empty array for empty/whitespace-only content', () => {
    expect(chunkText('', { chunkSize: 1000, chunkOverlap: 100 })).toEqual([]);
    expect(
      chunkText('   \n  ', { chunkSize: 1000, chunkOverlap: 100 }),
    ).toEqual([]);
  });

  it('splits long content into multiple chunks', () => {
    const long = 'a'.repeat(2500);
    const chunks = chunkText(long, { chunkSize: 1000, chunkOverlap: 100 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  it('prefers splitting on paragraph boundaries when one exists near the target size', () => {
    const paragraph1 = 'A'.repeat(400);
    const paragraph2 = 'B'.repeat(400);
    const content = `${paragraph1}\n\n${paragraph2}`;

    const chunks = chunkText(content, { chunkSize: 450, chunkOverlap: 50 });

    // The first chunk should end at (or very near) the paragraph boundary,
    // not mid-word — i.e. it should be exactly paragraph1 (trimmed).
    expect(chunks[0]).toBe(paragraph1);
  });

  it('every character of the original content appears in at least one chunk (no silent data loss)', () => {
    const content = Array.from(
      { length: 50 },
      (_, i) => `Sentence number ${i}. `,
    ).join('');
    const chunks = chunkText(content, { chunkSize: 200, chunkOverlap: 30 });

    const combined = chunks.join(' ');
    for (let i = 0; i < 50; i++) {
      expect(combined).toContain(`Sentence number ${i}.`);
    }
  });

  it('overlaps consecutive chunks so context is not lost at a boundary', () => {
    const content = Array.from({ length: 30 }, (_, i) => `word${i} `).join('');
    const chunks = chunkText(content, { chunkSize: 100, chunkOverlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    // The word right at the end of chunk[0] should also appear in chunk[1] —
    // proof the overlap window actually repeats content across the boundary.
    const wordsInFirstChunk = chunks[0].split(' ').filter(Boolean);
    const lastWordOfFirstChunk = wordsInFirstChunk.at(-1);
    expect(lastWordOfFirstChunk).toBeDefined();
    expect(chunks[1].includes(lastWordOfFirstChunk!)).toBe(true);
  });

  it('does not loop forever on a pathologically small chunkSize', () => {
    const content = 'a'.repeat(50);
    const chunks = chunkText(content, { chunkSize: 1, chunkOverlap: 1 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
  });
});
