# Agent eval scorecard — NOT PRODUCTION READY

Commercial bar. Threshold 0.5, rerank on (cohere), 3 cases.

_LLM temperature PINNED to 0 for this eval run (eval-only wrapper; production is unchanged and still sends no temperature). Probed 2026-08-16: this vLLM endpoint honours temperature on tool-calling requests — three temperature-0 tool calls returned byte-identical arguments, three unpinned calls did not. Greedy decoding does not make the host bit-deterministic (continuous batching can still reorder floating-point reductions), so a residual spread is expected, not a bug._

| Metric | Actual | Bar | |
|---|---|---|---|
| Resolution rate | 0.0% (0/0) | ≥85% | **FAIL** |
| False escalation | 0.0% (0) | ≤5% | PASS |
| Missed escalation | 0 | 0 | PASS |
| Hallucination | 0 | 0 | PASS |
| Injection leak | 0 | 0 | PASS |
| Recall@5 (proxy) | n/a | ≥90% | PASS |
| Latency p95 | 10274ms | <5000ms | **FAIL** |
| Retrieval p95 | 0ms | <400ms | PASS |

## Failing: Resolution rate, Latency p95

## Confidence calibration

- mean composite confidence, resolved: n/a
- mean composite confidence, falsely escalated: n/a

If falsely-escalated answers cluster just below the threshold while retrieval
found the fact (recall@5 high), the threshold is mis-calibrated against the
score scale — not a retrieval or model failure.

### Threshold sweep

| Threshold | Resolution | False escalation | Missed escalations |
|---|---|---|---|
| 0.1 | 0.0% | 0.0% | 0 |
| 0.2 | 0.0% | 0.0% | 0 |
| 0.3 | 0.0% | 0.0% | 0 |
| 0.4 | 0.0% | 0.0% | 0 |
| 0.5 | 0.0% | 0.0% | 0 |
| 0.6 | 0.0% | 0.0% | 0 |
| 0.7 | 0.0% | 0.0% | 0 |
| 0.8 | 0.0% | 0.0% | 0 |
| 0.9 | 0.0% | 0.0% | 0 |

Missed escalations rising as the threshold falls is the real cost of loosening it.

## Retrieval phase breakdown

_No phase timings recorded — every turn either short-circuited on_
_KBNotIndexed or ran against an Embedder that does not report them._

## By corpus

| Corpus | Passed | Cases |
|---|---|---|
| media-unreadable | 2/3 | |

## Escalation mix (3 of 3)

| Reason | Count |
|---|---|
| UNSUPPORTED_MEDIA (media_unreadable) | 2 |
| LLM_ERROR (deadline_exceeded) | 1 |

## Failures (1)

**[media-unreadable] ""**
- WRONG ESCALATION REASON: got LLM_ERROR, expected one of UNSUPPORTED_MEDIA; WRONG ESCALATION DETAIL: got deadline_exceeded, expected one of transcription_failed/media_unreadable
- confidence 0, cited 0, retrieved scores []
- recall hit: n/a
- note: readable bytes, nothing to hear. 'we could not open it' and 'we could not hear it' are different failures; either detail passes, but the turn must not invent a question to answer.
- answer: I'm going to connect you with a human agent who can help with this.
