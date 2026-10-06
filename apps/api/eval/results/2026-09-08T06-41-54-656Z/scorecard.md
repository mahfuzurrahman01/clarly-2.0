# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank on (cohere), 3 cases.

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 66.7% (2/3) | ≥85% | **FAIL** |
| False escalation | 33.3% (1) | ≤5% | **FAIL** |
| Missed escalation | 0 | 0 | PASS |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | n/a | ≥90% | PASS |
| Latency p95 | 8668ms | <5000ms | **FAIL** |
| Retrieval p95 | 0ms | <400ms | PASS |

## Failing: Resolution rate, False escalation, Latency p95

## Confidence calibration

- mean composite confidence, resolved: 1.000
- mean composite confidence, falsely escalated: 0.000

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 66.7% | 33.3% | 0 |
| 0.2 | 66.7% | 33.3% | 0 |
| 0.3 | 66.7% | 33.3% | 0 |
| 0.4 | 66.7% | 33.3% | 0 |
| 0.5 | 66.7% | 33.3% | 0 |
| 0.6 | 66.7% | 33.3% | 0 |
| 0.7 | 66.7% | 33.3% | 0 |
| 0.8 | 66.7% | 33.3% | 0 |
| 0.9 | 66.7% | 33.3% | 0 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown

_No phase timings recorded — every turn either short-circuited on_
_KBNotIndexed or ran against an Embedder that does not report them._

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| voice-support | 2/3 | |

## Escalation mix (1 of 3)

| Reason | Count |
|---|---|
| LLM_ERROR (deadline_exceeded) | 1 |

## Failures (1)

**[voice-support] "[voice] what is the delivery charge outside Dhaka"**
- FALSE ESCALATION (LLM_ERROR, confidence 0); missing expected content: "120"
- confidence 0, cited 0, retrieved scores []
- recall hit: n/a
- note: a proper noun (Dhaka) plus a number the transcript must carry accurately; a garbled place name retrieves the wrong row.
- answer: I'm going to connect you with a human agent who can help with this.
