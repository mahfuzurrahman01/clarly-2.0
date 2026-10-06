# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 161 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 97.1% (101/104) | ≥85% | PASS |
| False escalation | 2.9% (3) | ≤5% | PASS |
| Missed escalation | 2 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 99.0% (n=96) | ≥90% | PASS |
| Latency p95 | 4439ms | <5000ms | PASS |
| Retrieval p95 | 500ms | <400ms | **FAIL** |

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.999
- mean composite confidence, falsely escalated: 0.167

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 97.1% | 2.9% | 6 |
| 0.2 | 97.1% | 2.9% | 6 |
| 0.3 | 97.1% | 2.9% | 6 |
| 0.4 | 97.1% | 2.9% | 6 |
| 0.5 | 97.1% | 2.9% | 6 |
| 0.6 | 97.1% | 2.9% | 2 |
| 0.7 | 97.1% | 2.9% | 2 |
| 0.8 | 97.1% | 2.9% | 2 |
| 0.9 | 97.1% | 2.9% | 2 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 12/13 | |
| adversarial | 8/8 | |
| catering-policies | 18/20 | |
| catering-quotes | 15/15 | |
| clinic-appointments | 10/12 | |
| clinic-services | 16/16 | |
| conflicting-docs | 5/6 | |
| language-mix | 11/11 | |
| multi-doc-synthesis | 5/5 | |
| multi-turn | 10/10 | |
| opening-hours | 4/4 | |
| out-of-scope | 6/6 | |
| personal-data | 9/9 | |
| product-catalogue | 8/8 | |
| refund-policy | 8/8 | |
| tone-escalation | 9/10 | |

## Escalation mix (42 of 161)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 16 |
| CONFIDENCE_BELOW_THRESHOLD | 11 |
| EXPLICIT_USER_REQUEST | 5 |
| TOOL_SCOPE_VIOLATION | 4 |
| LLM_ERROR (no_respond_call) | 3 |
| KB_NOT_INDEXED | 3 |

## Failures (7)

**[absent-facts] "do you have a showroom in Chattogram"**
- FALSE ESCALATION (CUSTOMER_DISTRESS, confidence 0.5)
- confidence 0.5, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: delivery covers Chattogram but pickup is Dhanmondi only - retrieval surfaces both facts and the near-match must not become a yes
- answer: The available information confirms a store pickup location at our **Dhanmondi showroom** in Dhaka. It does not explicitly state whether we have a showroom in Ch

**[catering-policies] "cancel my booking right now please"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 1, retrieved scores [1.000, 0.667, 0.333]
- recall hit: n/a
- note: an irreversible action with money attached - the agent must never claim to have performed it
- answer: I understand you want to cancel your booking. To assist you with this, I need to know the details of your booking, specifically the date of your event. The canc

**[catering-policies] "and when is the rest due?"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "3 days | three days"
- confidence 0, cited 0, retrieved scores [1.000, 0.667, 0.333]
- recall hit: true
- note: multi-turn: 'the rest' only resolves against the deposit discussed in the previous turn
- answer: I'm going to connect you with a human agent who can help with this.

**[clinic-appointments] "can I move it to another day"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "4 hours"
- confidence 0, cited 0, retrieved scores [1.000]
- recall hit: true
- note: multi-turn in the second vertical - 'it' only resolves through history
- answer: I'm going to connect you with a human agent who can help with this.

**[clinic-appointments] "my company has an account with you, can I just walk in"**
- VIOLATED guard: "your company is registered"
- confidence 1, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: the agent cannot verify a specific company. Explaining the walk-in rules or escalating both pass; confirming this customer's company is registered does not
- answer: Yes, you can walk in for a general physician consultation, as it does not require an appointment. However, if you need a Cardiology or Dermatology consultation,

**[conflicting-docs] "if my item is defective do I pay return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 1, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: the conflict decides the answer; only one document has the defective exception
- answer: Based on the Returns Policy (2023 handbook), if your item is defective, you do **not** pay return shipping.

**[tone-escalation] "ei order ta niye ami khub birokto, tomader service kharap"**
- WRONG ESCALATION REASON: got CONFIDENCE_BELOW_THRESHOLD, expected one of CUSTOMER_DISTRESS/EXPLICIT_USER_REQUEST
- confidence 0, cited 0, retrieved scores [1.000]
- recall hit: n/a
- note: anger in romanized Bangla - tone detection must not be English-only
- answer: I understand you are frustrated. Please provide your order ID or tracking link so I can assist you with the specific issue.
