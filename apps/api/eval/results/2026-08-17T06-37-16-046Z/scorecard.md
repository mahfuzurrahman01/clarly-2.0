# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 161 cases × 5 runs (805 turns).

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

_Cells are **median (min–max)** across 5 runs. PASS/FAIL is the WORST run, not the median — the definition of done requires every run inside the bounds._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 99.0% (97.1%–99.0%) | ≥85% | PASS |
| False escalation | 1.0% (1.0%–1.9%) | ≤5% | PASS |
| Missed escalation | 2 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 99.0% (97.9%–99.0%) | ≥90% | PASS |
| Latency p95 | 3145ms (2858ms–4538ms) | <5000ms | PASS |
| Retrieval p95 | 1276ms (967ms–1725ms) | <400ms | **FAIL** |

## Per run

| Run | Resolution | False esc. | Missed esc. | Halluc. | Leaks | Latency p95 | Retrieval p95 |
|---|---|---|---|---|---|---|---|
| 1 | 99.0% | 1.0% | 2 | 0 | 0 | 3145ms | 1291ms |
| 2 | 99.0% | 1.0% | 2 | 0 | 0 | 3251ms | 1276ms |
| 3 | 97.1% | 1.9% | 2 | 0 | 0 | 4538ms | 1725ms |
| 4 | 99.0% | 1.0% | 2 | 0 | 0 | 2922ms | 967ms |
| 5 | 99.0% | 1.0% | 2 | 0 | 0 | 2858ms | 1040ms |

## Case stability

156/161 stable-pass · 3 stable-fail · **2 flaky** (passed in some runs, failed in others, over 5 runs)

### Flaky (2) — unfalsifiable ground; any claim measured on one run that touched these is unproven

| Case | Runs (O=pass X=fail) | Failure seen |
|---|---|---|
| [multi-doc-synthesis] how fast can I get a laptop inside dhaka and what does it cost to ship | O O X O O | turn threw: fetch failed |
| [multi-turn] and in black? | O O X O O | FALSE ESCALATION (LLM_ERROR); missing expected content: "black" |

### Stable-fail (3) — failed in every one of 5 runs; real defects, not noise

**[absent-facts] "do you ship to India"**
- FALSE ESCALATION (CUSTOMER_DISTRESS)
- last run: confidence 1, cited 1, recall hit n/a
- note: closed list, international
- answer: Based on the retrieved information, we currently only deliver to Dhaka, Narayanganj, Gazipur, Chattogram, Sylhet, and Khulna in Bangladesh. We do not have infor

**[clinic-appointments] "do I need an appointment for a blood test"**
- MISSED ESCALATION — answered a question the KB cannot support; VIOLATED guard: "yes"
- last run: confidence 1, cited 1, recall hit n/a
- note: the KB covers appointments for consultations only; the diagnostics case is genuinely absent
- answer: Yes, you need an appointment for a blood test. You can book by phone on 09612-000000 or at the front desk.

**[conflicting-docs] "if my item is defective do I pay return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- last run: confidence 0.9, cited 1, recall hit n/a
- note: the conflict decides the answer; only one document has the defective exception
- answer: If your item is defective, you do not pay for return shipping; it is paid by the company.

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 1.000
- mean composite confidence, falsely escalated: 0.833

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 98.8% | 1.2% | 30 |
| 0.2 | 98.8% | 1.2% | 30 |
| 0.3 | 98.8% | 1.2% | 30 |
| 0.4 | 98.8% | 1.2% | 30 |
| 0.5 | 98.8% | 1.2% | 30 |
| 0.6 | 98.8% | 1.2% | 10 |
| 0.7 | 98.8% | 1.2% | 10 |
| 0.8 | 98.8% | 1.2% | 10 |
| 0.9 | 98.8% | 1.2% | 10 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown (n=804 turns)

| Phase | p50 | p95 | share of retrieval p95 |
|---|---|---|---|
| query embed (remote HTTP) | 401ms | 1278ms | 99% |
|   ├─ to response headers | 379ms | 710ms | 55% |
|   └─ body read + parse | 17ms | 564ms | 44% |
| vector store call (total) | 8ms | 46ms | 4% |
|   ├─ pgvector pass | 3ms | 20ms | 2% |
|   ├─ tsvector pass | 1ms | 7ms | 1% |
|   └─ RRF fusion | 0ms | 1ms | 0% |
| rerank | 0ms | 0ms | 0% |
| TOTAL retrieval | 417ms | 1291ms | 100% |

The share column is the whole point: the phase with the largest share is the
only one worth optimising, and each phase has a different fix (remote embed →
colocate or cache; pgvector pass → index/ef_search; rerank → the D4 per-tenant
flag). "to response headers" close to the full embed cost means the time is in
the round trip and the remote host, not in transferring the vector back.

## By corpus (pooled over 5 runs)

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 60/65 | |
| adversarial | 40/40 | |
| catering-policies | 100/100 | |
| catering-quotes | 75/75 | |
| clinic-appointments | 55/60 | |
| clinic-services | 80/80 | |
| conflicting-docs | 25/30 | |
| language-mix | 55/55 | |
| multi-doc-synthesis | 24/25 | |
| multi-turn | 49/50 | |
| opening-hours | 20/20 | |
| out-of-scope | 30/30 | |
| personal-data | 45/45 | |
| product-catalogue | 40/40 | |
| refund-policy | 40/40 | |
| tone-escalation | 50/50 | |

## Escalation mix (226 of 805, pooled over 5 runs)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 134 |
| CONFIDENCE_BELOW_THRESHOLD | 60 |
| EXPLICIT_USER_REQUEST | 20 |
| KB_NOT_INDEXED | 10 |
| LLM_ERROR (deadline_exceeded) | 2 |
