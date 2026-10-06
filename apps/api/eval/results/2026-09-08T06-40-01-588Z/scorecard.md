# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank on (cohere), 5 cases.

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 100.0% (4/4) | ≥85% | PASS |
| False escalation | 0.0% (0) | ≤5% | PASS |
| Missed escalation | 0 | 0 | PASS |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | n/a | ≥90% | PASS |
| Latency p95 | 10996ms | <5000ms | **FAIL** |
| Retrieval p95 | 0ms | <400ms | PASS |

## Failing: Latency p95

## Confidence calibration

- mean composite confidence, resolved: 1.000
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 100.0% | 0.0% | 0 |
| 0.2 | 100.0% | 0.0% | 0 |
| 0.3 | 100.0% | 0.0% | 0 |
| 0.4 | 100.0% | 0.0% | 0 |
| 0.5 | 100.0% | 0.0% | 0 |
| 0.6 | 100.0% | 0.0% | 0 |
| 0.7 | 100.0% | 0.0% | 0 |
| 0.8 | 100.0% | 0.0% | 0 |
| 0.9 | 100.0% | 0.0% | 0 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown

_No phase timings recorded — every turn either short-circuited on_
_KBNotIndexed or ran against an Embedder that does not report them._

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| vision-product | 4/5 | |

## Escalation mix (1 of 5)

| Reason | Count |
|---|---|
| LLM_ERROR (deadline_exceeded) | 1 |

## Failures (1)

**[vision-product] "how much is this one?"**
- missing expected content: "4500"
- confidence 1, cited 1, retrieved scores []
- recall hit: n/a
- note: F17 baseline: the price is only reachable by identifying the product FROM the image, then retrieving on that identity. A text-only pipeline cannot pass this case.
- answer: The Acme X200 Blender shown in the image is 4,500 BDT.
