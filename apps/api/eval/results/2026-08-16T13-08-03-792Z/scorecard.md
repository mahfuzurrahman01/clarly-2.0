# Agent eval scorecard — PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 4 cases.

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% (4/4) | ≥85% | PASS |
| False escalation | 0.0% (0) | ≤5% | PASS |
| Missed escalation | 0 | 0 | PASS |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% (n=4) | ≥90% | PASS |
| Latency p95 | 1756ms | <5000ms | PASS |
| Retrieval p95 | 379ms | <400ms | PASS |

## Confidence calibration

- mean composite confidence, resolved: 1.000
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 0 |
| 0.2 | 100.0% | 0.0% | 0 |
| 0.3 | 100.0% | 0.0% | 0 |
| 0.4 | 100.0% | 0.0% | 0 |
| 0.5 | 100.0% | 0.0% | 0 |
| 0.6 | 100.0% | 0.0% | 0 |
| 0.7 | 100.0% | 0.0% | 0 |
| 0.8 | 100.0% | 0.0% | 0 |
| 0.9 | 100.0% | 0.0% | 0 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=4 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 366ms | 369ms | 97% |
|   ├─ to response headers | 348ms | 353ms | 93% |
|   └─ body read + parse | 16ms | 89ms | 23% |
| vector store call (total) | 7ms | 11ms | 3% |
|   ├─ pgvector pass | 2ms | 3ms | 1% |
|   ├─ tsvector pass | 1ms | 2ms | 1% |
|   └─ RRF fusion | 0ms | 0ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 374ms | 379ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| opening-hours | 4/4 | |
