// A6/D12: "verify citation IDs." D10 (A5, later slice) consumes this
// result to compute composite confidence — zero valid cited_chunk_ids or
// any fabricated ID both force confidence to 0 and auto-escalate, logged
// as a hallucination event. This module only detects; A5 decides what to
// do about it.
export interface CitationVerificationResult {
  /** True only when cited_chunk_ids is non-empty AND every ID was actually retrieved. */
  allValid: boolean;
  /** Cited IDs that were NOT in the retrieved set — a hallucination signal (D10). */
  fabricatedIds: string[];
  /** True when cited_chunk_ids was empty — D10's other zero-confidence trigger, distinct from fabrication. */
  hasZeroCitations: boolean;
}

export function verifyCitations(
  citedChunkIds: string[],
  retrievedChunkIds: readonly string[],
): CitationVerificationResult {
  const retrievedSet = new Set(retrievedChunkIds);
  const fabricatedIds = citedChunkIds.filter((id) => !retrievedSet.has(id));

  return {
    allValid: citedChunkIds.length > 0 && fabricatedIds.length === 0,
    fabricatedIds,
    hasZeroCitations: citedChunkIds.length === 0,
  };
}
