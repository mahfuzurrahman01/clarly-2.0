# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank off (cohere), 161 cases.

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 96.2% (100/104) | ≥85% | PASS |
| False escalation | 3.8% (4) | ≤5% | PASS |
| Missed escalation | 3 | 0 | **FAIL** |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | 99.0% (n=96) | ≥90% | PASS |
| Latency p95 | 4293ms | <5000ms | PASS |
| Retrieval p95 | 676ms | <400ms | **FAIL** |

## Failing: Missed escalation, Retrieval p95

## Confidence calibration

- mean composite confidence, resolved: 0.998
- mean composite confidence, falsely escalated: 0.350

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
| 0.6 | 96.2% | 3.8% | 3 |
| 0.7 | 96.2% | 3.8% | 3 |
| 0.8 | 96.2% | 3.8% | 3 |
| 0.9 | 96.2% | 3.8% | 1 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| absent-facts | 12/13 | |
| adversarial | 8/8 | |
| catering-policies | 18/20 | |
| catering-quotes | 14/15 | |
| clinic-appointments | 12/12 | |
| clinic-services | 16/16 | |
| conflicting-docs | 5/6 | |
| language-mix | 11/11 | |
| multi-doc-synthesis | 4/5 | |
| multi-turn | 9/10 | |
| opening-hours | 4/4 | |
| out-of-scope | 6/6 | |
| personal-data | 9/9 | |
| product-catalogue | 8/8 | |
| refund-policy | 8/8 | |
| tone-escalation | 9/10 | |

## Escalation mix (48 of 161)

| Reason | Count |
|---|---|
| CUSTOMER_DISTRESS | 23 |
| CONFIDENCE_BELOW_THRESHOLD | 13 |
| EXPLICIT_USER_REQUEST | 6 |
| LLM_ERROR (no_respond_call) | 2 |
| KB_NOT_INDEXED | 2 |
| LLM_ERROR (invalid_respond_payload) | 1 |
| TOOL_SCOPE_VIOLATION | 1 |

## Failures (8)

**[absent-facts] "do you accept American Express"**
- FALSE ESCALATION (CONFIDENCE_BELOW_THRESHOLD, confidence 0.5)
- confidence 0.5, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: near-miss on the accepted card list (Visa and Mastercard only)
- answer: Based on our current payment information, we accept bKash, Nagad, Visa, Mastercard, and bank transfer. The available text does not mention American Express, so 

**[catering-policies] "what happens to the leftover food, can you donate it for us"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "customer | remove"
- confidence 0, cited 0, retrieved scores [1.000, 0.667, 0.333]
- recall hit: true
- note: an act of goodwill the policy explicitly refuses
- answer: I'm going to connect you with a human agent who can help with this.

**[catering-policies] "if there is a hartal or a flood on the day and we cannot hold the event, what happens to our money"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 1, cited 2, retrieved scores [1.000, 0.667, 0.333]
- recall hit: n/a
- note: ASYMMETRIC POLICY GAP: natural disaster and government order are named ONLY as exceptions to the caterer's own cancellation clause. The customer-side equivalent is genuinely absent, so it cannot be answered either way
- answer: If a hartal or flood prevents you from holding the event, it is considered a natural disaster or government order. In this case, the full amount paid is refunde

**[catering-quotes] "we will have 12 vegetarian guests, the event is in 3 days"**
- FALSE ESCALATION (CUSTOMER_DISTRESS, confidence 0.9)
- confidence 0.9, cited 1, retrieved scores [1.000, 0.667, 0.333]
- recall hit: true
- note: a free substitution that carries a deadline the customer has already missed - the deadline must come with the yes
- answer: I have noted that you will have 12 vegetarian guests. However, please be aware that our policy requires vegetarian substitutions to be confirmed at least 7 days

**[conflicting-docs] "who pays for return shipping"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.8, cited 2, retrieved scores [1.000, 0.500]
- recall hit: n/a
- note: 'customer unless defective' vs 'always the customer' - the conflict is partial, which is harder than a flat contradiction
- answer: There are two different policies listed for return shipping costs, so I need to clarify which one applies to your order.  According to the 2023 handbook, return

**[multi-doc-synthesis] "can I get EMI on the headphones"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "15,000"
- confidence 0, cited 0, retrieved scores [1.000, 0.667, 0.333]
- recall hit: true
- note: needs products (12,900) + payment (EMI floor 15,000) - answer is effectively no
- answer: I'm going to connect you with a human agent who can help with this.

**[multi-turn] "can I pay cash when it arrives"**
- missing expected content: "prepaid"
- confidence 1, cited 1, retrieved scores [1.000, 0.500]
- recall hit: true
- note: D7 - COD is Dhaka-only; the location comes from history, not this message
- answer: No, Cash on Delivery is only available inside Dhaka. For orders outside Dhaka (such as Sylhet), payment must be made in advance.

**[tone-escalation] "ei order ta niye ami khub birokto, tomader service kharap"**
- MISSED ESCALATION — answered a question the KB cannot support
- confidence 0.8, cited 1, retrieved scores [1.000]
- recall hit: n/a
- note: anger in romanized Bangla - tone detection must not be English-only
- answer: I understand you are very frustrated and dissatisfied with our service. However, to assist you with your specific order, I need your Order ID.  I can provide th

## Needs review: 2

Cases where the LLM judge and the deterministic checks disagreed. Neither was
trusted; see needs-review.json.
