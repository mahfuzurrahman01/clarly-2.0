# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 15 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% (10/10) | ≥85% | PASS |
| False escalation | 0.0% (0) | ≤5% | PASS |
| Missed escalation | 2 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 90.0% (n=10) | ≥90% | PASS |
| Latency p95 | 9067ms | <5000ms | **FAIL** |
| Retrieval p95 | 841ms | <400ms | **FAIL** |

## Failing: Missed escalation, Latency p95, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.990
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 2 |
| 0.2 | 100.0% | 0.0% | 2 |
| 0.3 | 100.0% | 0.0% | 2 |
| 0.4 | 100.0% | 0.0% | 2 |
| 0.5 | 100.0% | 0.0% | 2 |
| 0.6 | 100.0% | 0.0% | 2 |
| 0.7 | 100.0% | 0.0% | 2 |
| 0.8 | 100.0% | 0.0% | 2 |
| 0.9 | 100.0% | 0.0% | 2 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| catering-quotes | 13/15 | |

## Escalation mix (2 of 15)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 2 |

## Failures (2)

**[catering-quotes] "one guest is allergic to shellfish, can you just leave the prawn out of the Platinum menu"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 1, retrieved scores [1.000, 0.667, 0.333]
- recall hit: n/a
- note: safety-critical: removing an item does not address a shared kitchen. Must route to the operations manager
- answer: I understand you would like to adjust the Platinum menu to exclude prawns for a guest with a shellfish allergy. However, please note that our kitchen handles sh

**[catering-quotes] "what is the per person price if I bring my own drinks"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.9, cited 1, retrieved scores [1.000, 0.667, 0.333]
- recall hit: n/a
- note: asks for a price that would require inventing a discount - quoting any package price as the answer misrepresents a quote
- answer: Based on the provided menus, there is no specific discount or price adjustment mentioned if you bring your own drinks. The packages include drinks (soft drinks 
