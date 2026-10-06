// A1: "chunking strategy." Recursive character splitting — split on the
// largest available boundary (paragraph, then sentence, then word, then
// hard character cutoff) so chunks stay coherent instead of splitting mid-
// sentence whenever a cleaner break exists nearby. No new dependency (D6's
// "no framework" reasoning extends to chunking too — this is a genuinely
// small, hand-rollable algorithm, not a reason to pull in LangChain).
export interface ChunkOptions {
  /** Target chunk size, in characters. Not a hard cap when a chunk cannot be split further (see maxChunkSize). */
  chunkSize: number;
  /** Characters repeated at the start of each chunk after the first, so context isn't lost at a chunk boundary. */
  chunkOverlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  chunkSize: 1000,
  chunkOverlap: 150,
};

const SPLIT_BOUNDARIES = ['\n\n', '\n', '. ', ' '];

export function chunkText(
  content: string,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= options.chunkSize) return [trimmed];

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    const end = Math.min(start + options.chunkSize, trimmed.length);
    const splitAt =
      end >= trimmed.length ? end : findSplitPoint(trimmed, start, end);
    const chunk = trimmed.slice(start, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);

    if (splitAt >= trimmed.length) break;
    // Next chunk starts `chunkOverlap` characters before this one ended,
    // but never before `start` (would loop forever on a tiny chunkSize).
    start = Math.max(splitAt - options.chunkOverlap, start + 1);
  }

  return chunks;
}

/** Finds the best boundary to split on at or before `end`, preferring the largest boundary type (paragraph > line > sentence > word). Falls back to the hard `end` cutoff if none is found within a reasonable look-back window. */
function findSplitPoint(text: string, start: number, end: number): number {
  const lookBackLimit = Math.max(start, end - Math.floor((end - start) / 2));

  for (const boundary of SPLIT_BOUNDARIES) {
    const idx = text.lastIndexOf(boundary, end);
    if (idx >= lookBackLimit && idx >= start) {
      return idx + boundary.length;
    }
  }

  return end;
}
