// A1/D4: Reciprocal Rank Fusion — combines the pgvector cosine-similarity
// ranking and the Postgres tsvector lexical ranking into one ranked list,
// without needing the two scores to be on comparable scales (cosine
// similarity and ts_rank are not directly comparable numbers; RRF only
// cares about rank position within each list). k=60 is the standard RRF
// constant from the original paper (Cormack et al.) and what most hybrid-
// search implementations default to — dampens the influence of any single
// list's top rank so one list can't dominate the fusion.
const RRF_K = 60;

export interface RankedItem {
  id: string;
}

export interface FusedItem {
  id: string;
  score: number;
}

/** Each input array is assumed already sorted best-first (rank 0 = best). */
export function reciprocalRankFusion(rankedLists: RankedItem[][]): FusedItem[] {
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    list.forEach((item, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contribution);
    });
  }

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}
