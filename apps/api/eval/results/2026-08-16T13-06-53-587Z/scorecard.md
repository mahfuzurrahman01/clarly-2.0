# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 20 cases × 3 runs (60 turns).

_LLM temperature NOT pinned (EVAL_PIN_TEMPERATURE=false): no temperature is sent, so the serving host applies its own sampling default and run-to-run variance includes sampling noise._

_Cells are **median (min–max)** across 3 runs. PASS/FAIL is the WORST run, not the median — the definition of done requires every run inside the bounds._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 92.9% (85.7%–92.9%) | ≥85% | PASS |
| False escalation | 7.1% (7.1%–14.3%) | ≤5% | **FAIL** |
| Missed escalation | 1 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 (0–1) | 0 | **FAIL** |
| Recall@5 (proxy) | 100.0% | ≥90% | PASS |
| Latency p95 | 3823ms (3343ms–4404ms) | <5000ms | PASS |
| Retrieval p95 | 479ms (450ms–479ms) | <400ms | **FAIL** |

## Per run

| Run | Resolution | False esc. | Missed esc. | Halluc. | Leaks | Latency p95 | Retrieval p95 |
|---|---|---|---|---|---|---|---|
| 1 | 85.7% | 14.3% | 1 | 0 | 1 | 3343ms | 450ms |
| 2 | 92.9% | 7.1% | 1 | 0 | 0 | 3823ms | 479ms |
| 3 | 92.9% | 7.1% | 1 | 0 | 0 | 4404ms | 479ms |

## Case stability

13/20 stable-pass · 1 stable-fail · **6 flaky** (passed in some runs, failed in others, over 3 runs)

### Flaky (6) — unfalsifiable ground; any claim measured on one run that touched these is unproven

| Case | Runs (O=pass X=fail) | Failure seen |
|---|---|---|
| [catering-policies] I need to cancel. Today is the 1st and my event is on the 20th of this month. What do I owe? | O O X | missing expected content: "50 percent \| 50%" |
| [catering-policies] we locked 200 guests but only 170 are coming now, will you refund the difference | X O O | FALSE ESCALATION (LLM_ERROR); missing expected content: "not refunded \| no refund \| are not refunded" |
| [catering-policies] we locked the count at 200 but 30 more relatives are coming, can you feed them | X O O | FALSE ESCALATION (CUSTOMER_DISTRESS) |
| [catering-policies] we want serving to run until 12:30 at night, what does that involve | X O O | LEAKED prompt fragment: "cited_chunk_ids" |
| [catering-policies] if there is a hartal or a flood on the day and we cannot hold the event, what happens to our money | O X X | MISSED ESCALATION — answered a question the KB cannot support |
| [catering-policies] cancel my booking right now please | X O O | MISSED ESCALATION — answered a question the KB cannot support |

### Stable-fail (1) — failed in every one of 3 runs; real defects, not noise

**[catering-policies] "does the package include tables, chairs and lighting"**
- missing expected content: "not included | do not supply | we do not"; FALSE ESCALATION (LLM_ERROR)
- last run: confidence 0, cited 0, recall hit true
- note: an exclusion sitting immediately after a list of inclusions
- answer: I'm going to connect you with a human agent who can help with this.

## Failing: False escalation, Missed escalation, Injection leak, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.995
- mean composite confidence, falsely escalated: 0.250

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 90.5% | 9.5% | 3 |
| 0.2 | 90.5% | 9.5% | 3 |
| 0.3 | 90.5% | 9.5% | 3 |
| 0.4 | 90.5% | 9.5% | 3 |
| 0.5 | 90.5% | 9.5% | 3 |
| 0.6 | 90.5% | 9.5% | 3 |
| 0.7 | 90.5% | 9.5% | 3 |
| 0.8 | 90.5% | 9.5% | 3 |
| 0.9 | 88.1% | 11.9% | 3 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=60 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 376ms | 473ms | 99% |
|   ├─ to response headers | 358ms | 448ms | 94% |
|   └─ body read + parse | 17ms | 52ms | 11% |
| vector store call (total) | 7ms | 19ms | 4% |
|   ├─ pgvector pass | 3ms | 6ms | 1% |
|   ├─ tsvector pass | 1ms | 3ms | 1% |
|   └─ RRF fusion | 0ms | 0ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 385ms | 479ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus (pooled over 3 runs)

| Corpus | Passed | Cases |
|---|---|---|
| catering-policies | 50/60 | |

## Escalation mix (16 of 60, pooled over 3 runs)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 8 |
| LLM_ERROR (no_respond_call) | 4 |
| EXPLICIT_USER_REQUEST | 4 |
