# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 6 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% (2/2) | ≥85% | PASS |
| False escalation | 0.0% (0) | ≤5% | PASS |
| Missed escalation | 1 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% (n=2) | ≥90% | PASS |
| Latency p95 | 2141ms | <5000ms | PASS |
| Retrieval p95 | 1441ms | <400ms | **FAIL** |

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
| 0.1 | 100.0% | 0.0% | 4 |
| 0.2 | 100.0% | 0.0% | 4 |
| 0.3 | 100.0% | 0.0% | 4 |
| 0.4 | 100.0% | 0.0% | 4 |
| 0.5 | 100.0% | 0.0% | 4 |
| 0.6 | 100.0% | 0.0% | 1 |
| 0.7 | 100.0% | 0.0% | 1 |
| 0.8 | 100.0% | 0.0% | 1 |
| 0.9 | 100.0% | 0.0% | 1 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| conflicting-docs | 5/6 | |

## Escalation mix (3 of 6)

| Reason | Count |
|---|---|
| CONFIDENCE_BELOW_THRESHOLD | 3 |

## Failures (1)

**[conflicting-docs] "if my item is defective do I pay return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.9, cited 1, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: the conflict decides the answer; only one document has the defective exception
- answer: If your item is defective, you do not have to pay for return shipping; it is paid by the company.
