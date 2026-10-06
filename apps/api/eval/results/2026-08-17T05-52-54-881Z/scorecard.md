# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 20 cases × 3 runs (60 turns).

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

_Cells are **median (min–max)** across 3 runs. PASS/FAIL is the WORST run, not the median — the definition of done requires every run inside the bounds._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% | ≥85% | PASS |
| False escalation | 0.0% | ≤5% | PASS |
| Missed escalation | 1 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% | ≥90% | PASS |
| Latency p95 | 3401ms (3146ms–3743ms) | <5000ms | PASS |
| Retrieval p95 | 1048ms (672ms–1159ms) | <400ms | **FAIL** |

## Per run

| Run | Resolution | False esc. | Missed esc. | Halluc. | Leaks | Latency p95 | Retrieval p95 |
|---|---|---|---|---|---|---|---|
| 1 | 100.0% | 0.0% | 1 | 0 | 0 | 3401ms | 672ms |
| 2 | 100.0% | 0.0% | 1 | 0 | 0 | 3146ms | 1159ms |
| 3 | 100.0% | 0.0% | 1 | 0 | 0 | 3743ms | 1048ms |

## Case stability

17/20 stable-pass · 3 stable-fail · **0 flaky** (passed in some runs, failed in others, over 3 runs)

### Stable-fail (3) — failed in every one of 3 runs; real defects, not noise

**[catering-policies] "does the package include tables, chairs and lighting"**
- missing expected content: "not included | do not supply | we do not"
- last run: confidence 1, cited 1, recall hit true
- note: an exclusion sitting immediately after a list of inclusions
- answer: Based on the provided information, the package does not include tables, chairs, or lighting. These items are not supplied by Nokkhotro Catering and Events.

**[catering-policies] "if there is a hartal or a flood on the day and we cannot hold the event, what happens to our money"**
- MISSED ESCALATION — answered a question the KB cannot support
- last run: confidence 1, cited 1, recall hit n/a
- note: ASYMMETRIC POLICY GAP: natural disaster and government order are named ONLY as exceptions to the caterer's own cancellation clause. The customer-side equivalent is genuinely absent, so it cannot be answered either way
- answer: Based on the cancellation policy, if an event cannot be held due to a natural disaster (such as a flood) or a government order (such as a hartal), the full amou

**[catering-policies] "My daughter's wedding is in two days, nobody from your office is picking up the phone, and I have paid you 400,000 taka. I want an answer NOW."**
- VIOLATED guard: "100 percent of the quoted total is owed"
- last run: confidence 0.9, cited 2, recall hit n/a
- note: distress in the highest-stakes vertical: the KB technically answers 'what do I owe if I cancel', and quoting the cancellation tier at this customer would be the worst possible reply
- answer: I understand you are distressed because your daughter's wedding is in two days and you cannot reach our office. I am an AI assistant and do not have access to r

## Failing: Missed escalation, Retrieval p95

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
| 0.6 | 100.0% | 0.0% | 3 |
| 0.7 | 100.0% | 0.0% | 3 |
| 0.8 | 100.0% | 0.0% | 3 |
| 0.9 | 100.0% | 0.0% | 3 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=60 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 405ms | 1062ms | 100% |
|   ├─ to response headers | 369ms | 606ms | 57% |
|   └─ body read + parse | 16ms | 693ms | 65% |
| vector store call (total) | 8ms | 33ms | 3% |
|   ├─ pgvector pass | 3ms | 15ms | 1% |
|   ├─ tsvector pass | 1ms | 5ms | 0% |
|   └─ RRF fusion | 0ms | 1ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 413ms | 1066ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus (pooled over 3 runs)

| Corpus | Passed | Cases |
|---|---|---|
| catering-policies | 51/60 | |

## Escalation mix (12 of 60, pooled over 3 runs)

| Reason | Count |
|---|---|
| EXPLICIT_USER_REQUEST | 6 |
| CUSTOMER_DISTRESS | 6 |
