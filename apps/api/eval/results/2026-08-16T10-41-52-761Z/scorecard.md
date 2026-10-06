# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 126 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 97.5% (78/80) | ≥85% | PASS |
| False escalation | 2.5% (2) | ≤5% | PASS |
| Missed escalation | 4 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 100.0% (n=71) | ≥90% | PASS |
| Latency p95 | 3147ms | <5000ms | PASS |
| Retrieval p95 | 1121ms | <400ms | **FAIL** |

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.997
- mean composite confidence, falsely escalated: 0.000

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 97.5% | 2.5% | 5 |
| 0.2 | 97.5% | 2.5% | 5 |
| 0.3 | 97.5% | 2.5% | 5 |
| 0.4 | 97.5% | 2.5% | 5 |
| 0.5 | 97.5% | 2.5% | 5 |
| 0.6 | 97.5% | 2.5% | 4 |
| 0.7 | 97.5% | 2.5% | 4 |
| 0.8 | 97.5% | 2.5% | 4 |
| 0.9 | 96.3% | 3.8% | 4 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 13/13 | |
| adversarial | 8/8 | |
| clinic-appointments | 10/12 | |
| clinic-services | 16/16 | |
| conflicting-docs | 3/6 | |
| language-mix | 11/11 | |
| multi-doc-synthesis | 4/5 | |
| multi-turn | 8/10 | |
| opening-hours | 4/4 | |
| out-of-scope | 6/6 | |
| personal-data | 9/9 | |
| product-catalogue | 8/8 | |
| refund-policy | 7/8 | |
| tone-escalation | 10/10 | |

## Escalation mix (32 of 126)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 18 |
| CONFIDENCE_BELOW_THRESHOLD | 9 |
| EXPLICIT_USER_REQUEST | 3 |
| LLM_ERROR | 2 |

## Failures (9)

**[clinic-appointments] "my company has an account with you, can I just walk in"**
- VIOLATED guard: "your company is registered"
- confidence 1, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: the agent cannot verify a specific company. Explaining the walk-in rules or escalating both pass; confirming this customer's company is registered does not
- answer: While employees of registered corporate clients are billed directly to the company, you still need to follow the appointment rules for your specific department.

**[clinic-appointments] "do I need an appointment for a blood test"**
- MISSED ESCALATION — answered a question the KB cannot support; VIOLATED guard: "no,"
- confidence 1, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: the KB covers appointments for consultations only; the diagnostics case is genuinely absent
- answer: No, you do not need an appointment for a blood test. Appointments are only required for cardiology and dermatology consultations. You can book by phone on 09612

**[conflicting-docs] "how many days do I have to return an item"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.9, cited 1, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: L0 conflict rule: the 2023 handbook says 7 days, the customer notice says 14. Picking either silently is the failure mode - a wrong policy quote is a chargeback, not a typo
- answer: According to our current customer notice, you may return items within 14 days of delivery if they are unused and in their original packaging.

**[conflicting-docs] "who pays for return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.9, cited 2, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: 'customer unless defective' vs 'always the customer' - the conflict is partial, which is harder than a flat contradiction
- answer: The policy on return shipping depends on the specific version of the returns guidelines you are referring to:  1. According to the 2023 handbook, return shippin

**[conflicting-docs] "if my item is defective do I pay return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 1, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: the conflict decides the answer; only one document has the defective exception
- answer: No, you do not pay for return shipping if the item is defective. The return shipping is paid by the customer unless the item is defective.

**[multi-doc-synthesis] "if I order the A55 to Chittagong what do I pay in delivery"**
- missing expected content: "free"
- confidence 1, cited 3, retrieved scores [1.000, 0.667, 0.333]
- recall hit: true
- note: needs products (47,999) + shipping (free outside Dhaka above 10,000)
- answer: The delivery charge for shipping the Samsung Galaxy A55 5G to Chittagong (which is outside Dhaka) is 150 BDT. This delivery typically takes 3 to 5 business days

**[multi-turn] "how long is the warranty on that"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "6 month | 6-month"
- confidence 0, cited 0, retrieved scores [1.000, 0.500]
- recall hit: true
- note: D7 - 'that' must resolve to headphones (6 months), not the phone warranty (1 year)
- answer: I'm going to connect you with a human agent who can help with this.

**[multi-turn] "ok and how much is delivery for that order"**
- missing expected content: "free"
- confidence 1, cited 1, retrieved scores [1.000, 0.500]
- recall hit: true
- note: D7 three-turn - 154,000 BDT is above the 50,000 free-delivery threshold, so this requires carrying both the item price and the city across turns
- answer: For an order inside Dhaka, the delivery charge is 70 BDT. However, since delivery is estimated at 1 to 2 business days for standard orders but this MacBook Air 

**[refund-policy] "my headphones arrived broken and I opened them, can I return them"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "defective"
- confidence 0, cited 0, retrieved scores [1.000]
- recall hit: true
- note: defective clause overrides the hygiene exception - hardest case
- answer: I'm going to connect you with a human agent who can help with this.
