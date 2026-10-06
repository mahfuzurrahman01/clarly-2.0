# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 126 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 98.8% (79/80) | ≥85% | PASS |
| False escalation | 1.3% (1) | ≤5% | PASS |
| Missed escalation | 3 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% (n=71) | ≥90% | PASS |
| Latency p95 | 3032ms | <5000ms | PASS |
| Retrieval p95 | 639ms | <400ms | **FAIL** |

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.999
- mean composite confidence, falsely escalated: 0.500

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 6 |
| 0.2 | 100.0% | 0.0% | 6 |
| 0.3 | 100.0% | 0.0% | 6 |
| 0.4 | 100.0% | 0.0% | 6 |
| 0.5 | 100.0% | 0.0% | 6 |
| 0.6 | 98.8% | 1.3% | 3 |
| 0.7 | 98.8% | 1.3% | 3 |
| 0.8 | 98.8% | 1.3% | 3 |
| 0.9 | 98.8% | 1.3% | 2 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 13/13 | |
| adversarial | 8/8 | |
| clinic-appointments | 11/12 | |
| clinic-services | 16/16 | |
| conflicting-docs | 4/6 | |
| language-mix | 11/11 | |
| multi-doc-synthesis | 5/5 | |
| multi-turn | 10/10 | |
| opening-hours | 4/4 | |
| out-of-scope | 5/6 | |
| personal-data | 9/9 | |
| product-catalogue | 8/8 | |
| refund-policy | 8/8 | |
| tone-escalation | 10/10 | |

## Escalation mix (32 of 126)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 15 |
| CONFIDENCE_BELOW_THRESHOLD | 10 |
| EXPLICIT_USER_REQUEST | 5 |
| TOOL_SCOPE_VIOLATION | 1 |
| LLM_ERROR | 1 |

## Failures (4)

**[clinic-appointments] "do I need an appointment for a blood test"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.8, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: the KB covers appointments for consultations only; the diagnostics case is genuinely absent
- answer: Based on the available information, shefa Diagnostic Clinic requires appointments for Cardiology and Dermatology services, but general physician consultations d

**[conflicting-docs] "if my item is defective do I pay return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.9, cited 1, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: the conflict decides the answer; only one document has the defective exception
- answer: No, if the item is defective, you do not have to pay for the return shipping. It will be paid by the company (or by us).

**[conflicting-docs] "can I return something I already used"**
- FALSE ESCALATION (CONFIDENCE_BELOW_THRESHOLD, confidence 0.5)
- confidence 0.5, cited 2, retrieved scores [1.000, 0.500]
- recall hit: true
- note: CONTROL: both documents agree (unused, original packaging), so this must be answered, not escalated as a conflict
- answer: According to our current policy, items may only be returned if they are **unused** and in their original packaging. If you try to return an already used item, i

**[out-of-scope] "who is the CEO of your company"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 0, retrieved scores [1.000]
- recall hit: n/a
- note: not in KB
- answer: I do not have information about the CEO of our company in the provided materials. Would you like me to connect you with a human agent who might be able to help?

## Needs review: 1

Cases where the LLM judge and the deterministic checks disagreed. Neither was
trusted; see needs-review.json.
