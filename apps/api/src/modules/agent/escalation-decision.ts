// A5/D10: composite confidence, not model self-report. Consumes A6's
// citation-verification result (the "hard override" inputs) plus the
// model's own respond-payload confidence and escalate/escalation_reason.
// Deliberately pure/input-driven, same rationale as PromptModule/
// GuardrailModule — no DI, fully unit-testable, no assumption about who
// calls it (A4's loop, once built).
//
// This function does NOT see forbidden-topic checks (A6, D12) or
// loop-level provider errors (A0/A4, RESCUE_POLICY) — those escalations
// happen at their own call sites, before or independent of this decision:
// D12's forbidden-topic check runs at intake, before the LLM is even
// called, and RESCUE_POLICY-driven escalations (LLM_ERROR from a breaker-
// open/timeout) are `escalation_source: 'error_forced'`, never routed
// through this "agent_decision" path. Mixing those into this function
// would violate D13's whole reason for splitting the two sources.
import type { EscalationReason, EscalationSource } from '@repo/errors';
import { admitsMissingInformation } from '../guardrail/absent-information';
import type { CitationVerificationResult } from '../guardrail/citation-verification';
import { acknowledgesCustomerDistress } from '../guardrail/distress-acknowledgement';
import { statesFigure } from '../guardrail/states-figure';
import type { RespondPayload } from '../guardrail/respond-payload.schema';

/**
 * D10 revision (2026-08-16, docs/decisions/A0-production-readiness-assessment.md
 * B1): the minimum retrieval support a cited answer must have before the model's
 * own confidence is allowed to carry the decision.
 *
 * Deliberately 0 — "at least one cited chunk was actually retrieved with a
 * non-zero score." Any higher value would be a threshold on a *relevance* score
 * whose scale differs per retrieval mode (RRF fusion and reranker output are not
 * the same units), which is exactly the miscalibration this constant replaces.
 * Exposed as a parameter so a tenant-level floor can be introduced later without
 * reshaping the decision.
 */
export const RETRIEVAL_SUPPORT_FLOOR = 0;

/**
 * Cycle 3 (2026-09-30): the most confidence an answer may report when nothing
 * backs it, that is no cited chunk and no tool result, and it was let through
 * only because the model declared `no_kb_needed` (a greeting, a thank-you, a
 * refusal). Such an answer states no business fact, so there is nothing to be
 * 100% sure of; catering-quotes#13 scored 1.0 on an uncited claim about what the
 * business does not sell. Never lowered below the tenant's own threshold (see
 * `computeEscalationDecision`), so a strict threshold cannot turn every
 * "hi" into a handoff.
 */
export const UNCITED_CONFIDENCE_CAP = 0.9;

export interface EscalationDecision {
  /** D10: the model's self-reported confidence once the retrieval-support gate passes; forced to 0 by any hard override. */
  compositeConfidence: number;
  escalate: boolean;
  escalationReason: EscalationReason | null;
  escalationSource: EscalationSource | null;
  /** D10: "log as hallucination event" — a fabricated citation is a distinct signal from "just below threshold," surfaced separately for A8's future telemetry rather than folded into escalationReason (D13's enum has no separate value for it; CONFIDENCE_BELOW_THRESHOLD still applies). */
  isHallucination: boolean;
}

export function computeEscalationDecision(
  payload: RespondPayload,
  citationResult: CitationVerificationResult,
  retrievalSupportScore: number,
  confidenceThreshold: number,
  retrievalSupportFloor: number = RETRIEVAL_SUPPORT_FLOOR,
  /**
   * D10 extension for A11/A12 (Feature 17), 0..1 — how well this turn's
   * non-text input was understood (ASR clarity, image legibility). 1 for a text
   * turn, which leaves the formula below identical to the pre-Feature-17 one.
   *
   * Applied as a CAP on the composite, not as another gate, and the tenant's
   * threshold is untouched: "same confidence bar as a text question" means the
   * bar does not move for a photo — what moves is our confidence when we could
   * barely read what the customer sent.
   */
  modalityConfidence = 1,
  /**
   * F27 (2026-09-22): the customer's OWN message reports a loss or a wrong
   * outcome — see guardrail/customer-grievance.ts, whose caller runs it on the
   * incoming text. The answer-side net below can only fire on an answer written
   * in English, so without this input-side signal every Arabic-dialect complaint
   * either escalated under CONFIDENCE_BELOW_THRESHOLD or was answered with
   * policy text. Decided by the caller, applied here in one place so a grievance
   * turn carries the same reason whichever branch ends it.
   */
  customerGrievance = false,
  /**
   * L2 (2026-09-28): at least one tool call executed this turn, so the answer
   * can rest on tool results (catalog rows, an order, a shipment) rather than
   * on cited chunks. Waives the zero-citation override exactly the way
   * `no_kb_needed` does — see `toolGroundedTurn` below.
   */
  toolGrounded = false,
  /**
   * Cycle 3 (2026-09-30): the customer's message mentions an allergy, a health
   * condition or a safety incident — see guardrail/safety-risk.ts. A wrong
   * answer here can hurt someone, so the handoff does not depend on the model
   * remembering to set `escalate`: it happens on every such turn, whatever the
   * model, the citations or the confidence said.
   */
  safetyRisk = false,
  /**
   * Cycle 3 (2026-09-30): the customer says the order is late AND this turn's
   * track_order result shows an overdue or problem shipment — see
   * guardrail/late-delivery-complaint.ts. A complaint stated by the customer
   * escalates even though a tool answered the question.
   */
  lateDeliveryComplaint = false,
  /**
   * Cycle 3b (2026-10-04): this turn's track_order calls found no shipment —
   * see guardrail/shipment-not-found.ts. The tool's contract is "say you could
   * not find it and escalate"; an answer that only says the first half still
   * hands off.
   */
  shipmentNotFound = false,
): EscalationDecision {
  // D10 hard override: an invalid citation set (zero citations OR any
  // fabricated ID) forces confidence to 0, unconditionally — the model's
  // own self-reported confidence and the retrieval score are both
  // irrelevant once this triggers.
  //
  // Retrieval support is the SECOND gate, not a factor. It used to be
  // min()'d into the composite, which silently made an uncalibrated
  // relevance score the effective confidence (B1): a correctly retrieved,
  // correctly cited, correctly answered turn scoring 0.22 on the reranker
  // was escalated against a 0.5 threshold. Below the floor means "nothing
  // relevant actually backed this answer" and still forces 0; above it, the
  // model's own confidence — the only input that is on a probability scale —
  // carries the decision against the tenant's threshold.
  // The zero-citation half of the override is waived for a turn the model
  // declares needed no knowledge base at all — a greeting, a thank-you, or a
  // refusal to handle sensitive data. Without this, "hi" scores 0 and every
  // WhatsApp conversation opens with a handoff to a human. Never waived for a
  // fabricated citation (that is a hallucination, not a no-KB turn), and never
  // when the model is escalating anyway.
  //
  // Cycle 3: also never waived for an answer that says the information does not
  // cover the question ("it does not mention photography"). That is a statement
  // about the business, the flag's own definition excludes it, and it is exactly
  // the turn L0 hands to a human (catering-quotes#13, 5/5 missed).
  //
  // Cycle 3b: and never for an answer that states a figure (a price, a number
  // of days, a fee, a phone number). v14 lets the model mark a clarifying
  // question ("which one do you mean?") as no-KB, so a confidence-0 handoff is
  // no longer the reply to an ambiguous message; this keeps that from becoming
  // a way to state an uncited price. See guardrail/states-figure.ts.
  const noKbTurn =
    payload.no_kb_needed === true &&
    !payload.escalate &&
    citationResult.fabricatedIds.length === 0 &&
    payload.cited_chunk_ids.length === 0 &&
    !admitsMissingInformation(payload.answer) &&
    !statesFigure(payload.answer);

  // Same waiver for an answer built from this turn's tool results. Before it,
  // every lookup_product/track_order answer cited nothing (there is no chunk
  // for a live price or a shipment status) and was zeroed and handed to a
  // human. The same exclusions hold: never with a fabricated citation, never
  // while escalating, and an answer that cites chunks is judged on them.
  const toolGroundedTurn =
    toolGrounded &&
    !payload.escalate &&
    citationResult.fabricatedIds.length === 0 &&
    payload.cited_chunk_ids.length === 0;

  const supported =
    (citationResult.allValid &&
      retrievalSupportScore > retrievalSupportFloor) ||
    noKbTurn ||
    toolGroundedTurn;
  // An uncited answer that no tool grounds is capped below certainty (see
  // UNCITED_CONFIDENCE_CAP). A tool-grounded answer is judged on its tool
  // results and a cited one on its chunks, so neither is capped.
  const uncitedCap =
    noKbTurn && !toolGroundedTurn
      ? Math.max(UNCITED_CONFIDENCE_CAP, confidenceThreshold)
      : 1;
  const compositeConfidence = supported
    ? Math.min(payload.confidence, modalityConfidence, uncitedCap)
    : 0;

  const isHallucination = citationResult.fabricatedIds.length > 0;
  const belowThreshold = compositeConfidence < confidenceThreshold;

  // Safety first: decided before the confidence rule and before the model's own
  // choice, because neither may talk the turn out of a handoff. The reason is
  // the L0 "reports harm" limb; the one label that stays is the customer's own
  // request for a person, which is the more specific truth.
  if (safetyRisk) {
    return {
      compositeConfidence,
      escalate: true,
      escalationReason:
        payload.escalate &&
        payload.escalation_reason === 'EXPLICIT_USER_REQUEST'
          ? 'EXPLICIT_USER_REQUEST'
          : 'CUSTOMER_DISTRESS',
      escalationSource: 'agent_decision',
      isHallucination,
    };
  }

  // The reason the deterministic input-side nets assign, when one fired. A
  // grievance is the customer's state (CUSTOMER_DISTRESS); a proven-late
  // shipment they complain about is a problem with an order (CUSTOMER_COMPLAINT).
  const netReason: EscalationReason | null = customerGrievance
    ? 'CUSTOMER_DISTRESS'
    : lateDeliveryComplaint
      ? 'CUSTOMER_COMPLAINT'
      : null;

  if (belowThreshold) {
    // D10: the confidence rule always wins on WHETHER to escalate — the model's
    // own escalate:false cannot overrule it.
    //
    // It does not win on WHY. When the model independently asked to escalate
    // and named a reason, that reason is the accurate one and
    // CONFIDENCE_BELOW_THRESHOLD is an artefact: a tone-driven handoff cites
    // nothing (there is no KB fact to cite), so the zero-citation override
    // zeroes it and the label used to come back as a confidence failure. That
    // made CUSTOMER_DISTRESS and EXPLICIT_USER_REQUEST invisible in the
    // escalation mix — measured on the 2026-08-16 eval, where every romanized-
    // Bangla anger case escalated correctly under the wrong label. A fabricated
    // citation is the exception: there the confidence failure is the real story.
    //
    // F27: the model's own label is only better than CONFIDENCE_BELOW_THRESHOLD
    // when it is a different label. On the Gulf Arabic corpora it escalated a
    // grievance turn and still named CONFIDENCE_BELOW_THRESHOLD, which the
    // grievance signal corrects to the reason L0 actually asks for.
    const modelReason =
      payload.escalate && payload.escalation_reason && !isHallucination
        ? payload.escalation_reason
        : null;
    const reason: EscalationReason =
      modelReason && modelReason !== 'CONFIDENCE_BELOW_THRESHOLD'
        ? modelReason
        : netReason && !isHallucination
          ? netReason
          : (modelReason ?? 'CONFIDENCE_BELOW_THRESHOLD');

    return {
      compositeConfidence,
      escalate: true,
      escalationReason: reason,
      escalationSource: 'agent_decision',
      isHallucination,
    };
  }

  if (payload.escalate) {
    // Confidence is fine, but the model itself decided to escalate (e.g.
    // it recognized an explicit human handoff request) — respect its
    // stated reason, already guaranteed present by RespondPayloadSchema's
    // refine() when escalate is true.
    //
    // F27: except when that reason is CONFIDENCE_BELOW_THRESHOLD on a turn whose
    // confidence is demonstrably fine — that label cannot be true here, and on a
    // grievance turn the accurate one is CUSTOMER_DISTRESS.
    const selfReported = payload.escalation_reason ?? null;
    return {
      compositeConfidence,
      escalate: true,
      escalationReason:
        netReason &&
        (selfReported === null || selfReported === 'CONFIDENCE_BELOW_THRESHOLD')
          ? netReason
          : selfReported,
      escalationSource: 'agent_decision',
      isHallucination,
    };
  }

  // Last gate: the model wrote an answer that states the customer is angry or
  // upset, and then chose not to hand off. D12's deterministic counterpart to
  // L0's distress rule — see distress-acknowledgement.ts for the measurement
  // behind it. `escalation_reason` is decided HERE, at the call site that
  // detects it, and never inferred downstream.
  // F27 adds the input-side half: the customer's own message reported the loss,
  // whether or not the answer ever names their state.
  // Cycle 3 adds the proven-late shipment the customer complained about.
  if (
    customerGrievance ||
    lateDeliveryComplaint ||
    acknowledgesCustomerDistress(payload.answer)
  ) {
    return {
      compositeConfidence,
      escalate: true,
      escalationReason: netReason ?? 'CUSTOMER_DISTRESS',
      escalationSource: 'agent_decision',
      isHallucination,
    };
  }

  // Cycle 3b: nothing above fired and the model did not escalate, but the
  // shipment it was asked about does not exist for this customer. Decided
  // here, at the one call site that sees it; KB_NOT_INDEXED is the reason the
  // escalation enum documents for "nothing covers this" (see KB_CONFLICT).
  if (shipmentNotFound) {
    return {
      compositeConfidence,
      escalate: true,
      escalationReason: 'KB_NOT_INDEXED',
      escalationSource: 'agent_decision',
      isHallucination,
    };
  }

  return {
    compositeConfidence,
    escalate: false,
    escalationReason: null,
    escalationSource: null,
    isHallucination,
  };
}

/**
 * Eval A1 (2026-09-29, full-qwen run, commerce-lookup 75/75 turns escalated at
 * confidence 0 with isHallucination=true although every answer was correct and
 * tool-grounded): a KB-less tenant retrieves zero chunks, yet the model still
 * put a handle like "c1" in cited_chunk_ids. With nothing retrieved a handle
 * cannot refer to anything, so verifyCitations() counted it fabricated, which
 * blocked the `toolGrounded` waiver above and logged a hallucination.
 *
 * When ZERO chunks were retrieved and a tool executed, the cited handles are
 * dropped BEFORE verification, so the turn is judged as "zero citations,
 * tool-grounded" - the case the waiver already handles. Returns the payload
 * unchanged (same reference) in every other case, so the fabricated-citation
 * rule stays fully intact whenever chunks WERE retrieved (citing a handle that
 * does not exist among real chunks is still a hallucination) and whenever no
 * tool supplied evidence.
 */
export function dropUnresolvableCitations(
  payload: RespondPayload,
  retrievedChunkCount: number,
  toolGrounded: boolean,
): RespondPayload {
  if (
    retrievedChunkCount > 0 ||
    !toolGrounded ||
    payload.cited_chunk_ids.length === 0
  ) {
    return payload;
  }
  return { ...payload, cited_chunk_ids: [] };
}
