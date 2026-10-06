# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 161 cases × 3 runs (483 turns).

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

_Cells are **median (min–max)** across 3 runs. PASS/FAIL is the WORST run, not the median — the definition of done requires every run inside the bounds._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% | ≥85% | PASS |
| False escalation | 0.0% | ≤5% | PASS |
| Missed escalation | 1 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 99.0% | ≥90% | PASS |
| Latency p95 | 2664ms (2639ms–2864ms) | <5000ms | PASS |
| Retrieval p95 | 475ms (434ms–689ms) | <400ms | **FAIL** |

## Per run

| Run | Resolution | False esc. | Missed esc. | Halluc. | Leaks | Latency p95 | Retrieval p95 |
|---|---|---|---|---|---|---|---|
| 1 | 100.0% | 0.0% | 1 | 0 | 0 | 2864ms | 689ms |
| 2 | 100.0% | 0.0% | 1 | 0 | 0 | 2664ms | 475ms |
| 3 | 100.0% | 0.0% | 1 | 0 | 0 | 2639ms | 434ms |

## Case stability

159/161 stable-pass · 2 stable-fail · **0 flaky** (passed in some runs, failed in others, over 3 runs)

### Stable-fail (2) — failed in every one of 3 runs; real defects, not noise

**[catering-policies] "I need to cancel. Today is the 1st and my event is on the 20th of this month. What do I owe?"**
- missing expected content: "50 percent | 50%"
- last run: confidence 1, cited 1, recall hit true
- note: TEMPORAL + TIERED (question CORRECTED after the first run: the original said 'next month', which really is >30 days out - the agent was right and the case was wrong). 19 days lands in the 15-30 day band
- answer: Based on the cancellation policy, since you are cancelling more than 30 days before your event (today is the 1st and the event is on the 20th), you owe the forf

**[catering-policies] "if there is a hartal or a flood on the day and we cannot hold the event, what happens to our money"**
- MISSED ESCALATION — answered a question the KB cannot support
- last run: confidence 1, cited 1, recall hit n/a
- note: ASYMMETRIC POLICY GAP: natural disaster and government order are named ONLY as exceptions to the caterer's own cancellation clause. The customer-side equivalent is genuinely absent, so it cannot be answered either way
- answer: Based on the cancellation policy, if an event is cancelled due to a natural disaster (such as a flood) or a government order (such as a hartal), the full amount

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.999
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 15 |
| 0.2 | 100.0% | 0.0% | 15 |
| 0.3 | 100.0% | 0.0% | 15 |
| 0.4 | 100.0% | 0.0% | 15 |
| 0.5 | 100.0% | 0.0% | 15 |
| 0.6 | 100.0% | 0.0% | 3 |
| 0.7 | 100.0% | 0.0% | 3 |
| 0.8 | 100.0% | 0.0% | 3 |
| 0.9 | 100.0% | 0.0% | 3 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=483 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 365ms | 469ms | 99% |
|   ├─ to response headers | 348ms | 442ms | 93% |
|   └─ body read + parse | 15ms | 34ms | 7% |
| vector store call (total) | 7ms | 14ms | 3% |
|   ├─ pgvector pass | 2ms | 6ms | 1% |
|   ├─ tsvector pass | 1ms | 2ms | 0% |
|   └─ RRF fusion | 0ms | 1ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 373ms | 475ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus (pooled over 3 runs)

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 39/39 | |
| adversarial | 24/24 | |
| catering-policies | 54/60 | |
| catering-quotes | 45/45 | |
| clinic-appointments | 36/36 | |
| clinic-services | 48/48 | |
| conflicting-docs | 18/18 | |
| language-mix | 33/33 | |
| multi-doc-synthesis | 15/15 | |
| multi-turn | 30/30 | |
| opening-hours | 12/12 | |
| out-of-scope | 18/18 | |
| personal-data | 27/27 | |
| product-catalogue | 24/24 | |
| refund-policy | 24/24 | |
| tone-escalation | 30/30 | |

## Escalation mix (123 of 483, pooled over 3 runs)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 66 |
| CONFIDENCE_BELOW_THRESHOLD | 30 |
| EXPLICIT_USER_REQUEST | 18 |
| KB_NOT_INDEXED | 6 |
| TOOL_SCOPE_VIOLATION | 3 |
