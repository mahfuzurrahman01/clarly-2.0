# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 20 cases × 3 runs (60 turns).

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

_Cells are **median (min–max)** across 3 runs. PASS/FAIL is the WORST run, not the median — the definition of done requires every run inside the bounds._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% | ≥85% | PASS |
| False escalation | 0.0% | ≤5% | PASS |
| Missed escalation | 0 | 0 | PASS |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% | ≥90% | PASS |
| Latency p95 | 3198ms (2989ms–3861ms) | <5000ms | PASS |
| Retrieval p95 | 1041ms (1028ms–1391ms) | <400ms | **FAIL** |

## Per run

| Run | Resolution | False esc. | Missed esc. | Halluc. | Leaks | Latency p95 | Retrieval p95 |
|---|---|---|---|---|---|---|---|
| 1 | 100.0% | 0.0% | 0 | 0 | 0 | 3198ms | 1041ms |
| 2 | 100.0% | 0.0% | 0 | 0 | 0 | 2989ms | 1028ms |
| 3 | 100.0% | 0.0% | 0 | 0 | 0 | 3861ms | 1391ms |

## Case stability

20/20 stable-pass · 0 stable-fail · **0 flaky** (passed in some runs, failed in others, over 3 runs)

## Failing: Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 1.000
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 3 |
| 0.2 | 100.0% | 0.0% | 3 |
| 0.3 | 100.0% | 0.0% | 3 |
| 0.4 | 100.0% | 0.0% | 3 |
| 0.5 | 100.0% | 0.0% | 3 |
| 0.6 | 100.0% | 0.0% | 0 |
| 0.7 | 100.0% | 0.0% | 0 |
| 0.8 | 100.0% | 0.0% | 0 |
| 0.9 | 100.0% | 0.0% | 0 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=60 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 393ms | 1262ms | 99% |
|   ├─ to response headers | 363ms | 489ms | 38% |
|   └─ body read + parse | 19ms | 662ms | 52% |
| vector store call (total) | 11ms | 55ms | 4% |
|   ├─ pgvector pass | 4ms | 20ms | 2% |
|   ├─ tsvector pass | 2ms | 11ms | 1% |
|   └─ RRF fusion | 0ms | 1ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 414ms | 1273ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus (pooled over 3 runs)

| Corpus | Passed | Cases |
|---|---|---|
| catering-policies | 60/60 | |

## Escalation mix (18 of 60, pooled over 3 runs)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 9 |
| EXPLICIT_USER_REQUEST | 6 |
| CONFIDENCE_BELOW_THRESHOLD | 3 |
