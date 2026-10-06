import type { CitationVerificationResult } from '../guardrail/citation-verification';
import type { RespondPayload } from '../guardrail/respond-payload.schema';
import {
  computeEscalationDecision,
  dropUnresolvableCitations,
  UNCITED_CONFIDENCE_CAP,
} from './escalation-decision';
import { verifyCitations } from '../guardrail/citation-verification';

const VALID_CITATIONS: CitationVerificationResult = {
  allValid: true,
  fabricatedIds: [],
  hasZeroCitations: false,
};

const ZERO_CITATIONS: CitationVerificationResult = {
  allValid: false,
  fabricatedIds: [],
  hasZeroCitations: true,
};

const FABRICATED_CITATIONS: CitationVerificationResult = {
  allValid: false,
  fabricatedIds: ['chunk-99'],
  hasZeroCitations: false,
};

function payload(overrides: Partial<RespondPayload> = {}): RespondPayload {
  return {
    answer: 'Your order ships in 3-5 days.',
    cited_chunk_ids: ['chunk-1'],
    confidence: 0.9,
    escalate: false,
    ...overrides,
  };
}

describe('computeEscalationDecision()', () => {
  it('D10/B1: composite confidence is the model self-report once the retrieval-support gate passes', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      VALID_CITATIONS,
      0.6,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0.9);
  });

  it('B1: high model confidence + a real citation + a MID retrieval score does not escalate (the regression this gate replaces)', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      VALID_CITATIONS,
      0.225, // a real reranker score from the 2026-08-16 eval run
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0.9);
    expect(decision.escalate).toBe(false);
    expect(decision.escalationReason).toBeNull();
  });

  it('B1: retrieval support at or below the floor forces confidence to 0 and escalates', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.95 }),
      VALID_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.isHallucination).toBe(false);
  });

  it('B1: an explicit retrieval-support floor gates a weakly supported answer', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.95 }),
      VALID_CITATIONS,
      0.1,
      0.5,
      0.2,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
  });

  it('does not escalate when composite confidence is at or above the threshold and the model did not ask to escalate', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      VALID_CITATIONS,
      0.8,
      0.7,
    );

    expect(decision.escalate).toBe(false);
    expect(decision.escalationReason).toBeNull();
    expect(decision.escalationSource).toBeNull();
  });

  it('D10: zero valid citations forces confidence to 0 and auto-escalates with CONFIDENCE_BELOW_THRESHOLD', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.95, cited_chunk_ids: [] }),
      ZERO_CITATIONS,
      0.95,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.escalationSource).toBe('agent_decision');
    expect(decision.isHallucination).toBe(false);
  });

  it('D10: a fabricated citation forces confidence to 0, auto-escalates, and is logged as a hallucination', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.95, cited_chunk_ids: ['chunk-1', 'chunk-99'] }),
      FABRICATED_CITATIONS,
      0.95,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.isHallucination).toBe(true);
  });

  it('the tenant confidence threshold is what actually gates escalation (D10: makes the tenant-tunable 0.7 mean something)', () => {
    const lowThreshold = computeEscalationDecision(
      payload({ confidence: 0.6 }),
      VALID_CITATIONS,
      0.6,
      0.5,
    );
    const highThreshold = computeEscalationDecision(
      payload({ confidence: 0.6 }),
      VALID_CITATIONS,
      0.6,
      0.9,
    );

    expect(lowThreshold.escalate).toBe(false);
    expect(highThreshold.escalate).toBe(true);
    expect(highThreshold.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });

  it("respects the model's own escalate:true/escalation_reason when confidence is above threshold", () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.95,
        escalate: true,
        escalation_reason: 'EXPLICIT_USER_REQUEST',
      }),
      VALID_CITATIONS,
      0.95,
      0.5,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('EXPLICIT_USER_REQUEST');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it("keeps the model's own escalation_reason when low confidence and a model-initiated escalation coincide", () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.2,
        escalate: true,
        escalation_reason: 'EXPLICIT_USER_REQUEST',
      }),
      VALID_CITATIONS,
      0.9,
      0.5,
    );

    // Escalating is not in question either way; the label is. The model's
    // stated reason is the accurate one.
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('EXPLICIT_USER_REQUEST');
  });

  it('labels a tone escalation CUSTOMER_DISTRESS even though it cites nothing and therefore scores 0', () => {
    const decision = computeEscalationDecision(
      payload({
        cited_chunk_ids: [],
        confidence: 0.9,
        escalate: true,
        escalation_reason: 'CUSTOMER_DISTRESS',
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('a fabricated citation still reports CONFIDENCE_BELOW_THRESHOLD, whatever reason the model stated', () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.9,
        escalate: true,
        escalation_reason: 'EXPLICIT_USER_REQUEST',
      }),
      FABRICATED_CITATIONS,
      0.9,
      0.5,
    );

    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.isHallucination).toBe(true);
  });

  describe('toolGrounded (answers built from tool results)', () => {
    const decide = (
      p: RespondPayload,
      citations: CitationVerificationResult,
      toolGrounded: boolean,
    ) =>
      computeEscalationDecision(
        p,
        citations,
        0,
        0.5,
        undefined,
        1,
        false,
        toolGrounded,
      );

    it('keeps the model confidence for a zero-citation answer when a tool ran', () => {
      const decision = decide(
        payload({ cited_chunk_ids: [], confidence: 0.85 }),
        ZERO_CITATIONS,
        true,
      );

      expect(decision.compositeConfidence).toBe(0.85);
      expect(decision.escalate).toBe(false);
    });

    it('still zeroes a zero-citation answer when no tool ran', () => {
      const decision = decide(
        payload({ cited_chunk_ids: [], confidence: 0.85 }),
        ZERO_CITATIONS,
        false,
      );

      expect(decision.compositeConfidence).toBe(0);
      expect(decision.escalate).toBe(true);
    });

    it('never waives the override for a fabricated citation', () => {
      const decision = decide(
        payload({ cited_chunk_ids: ['chunk-99'], confidence: 0.95 }),
        FABRICATED_CITATIONS,
        true,
      );

      expect(decision.compositeConfidence).toBe(0);
      expect(decision.isHallucination).toBe(true);
    });

    it('does not apply when the model escalates — its own reason stands', () => {
      const decision = decide(
        payload({
          cited_chunk_ids: [],
          confidence: 0.9,
          escalate: true,
          escalation_reason: 'CUSTOMER_COMPLAINT',
        }),
        ZERO_CITATIONS,
        true,
      );

      expect(decision.escalate).toBe(true);
      expect(decision.escalationReason).toBe('CUSTOMER_COMPLAINT');
    });

    it('still escalates on low model confidence', () => {
      const decision = decide(
        payload({ cited_chunk_ids: [], confidence: 0.3 }),
        ZERO_CITATIONS,
        true,
      );

      expect(decision.escalate).toBe(true);
      expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    });
  });

  describe('no_kb_needed (greetings and small talk)', () => {
    it('does not escalate a zero-citation greeting the model declared needs no KB', () => {
      const decision = computeEscalationDecision(
        payload({
          answer: 'Hello! How can I help you today?',
          cited_chunk_ids: [],
          confidence: 0.9,
          no_kb_needed: true,
        }),
        ZERO_CITATIONS,
        0,
        0.5,
      );

      expect(decision.compositeConfidence).toBe(0.9);
      expect(decision.escalate).toBe(false);
    });

    it('still escalates a zero-citation turn that did NOT declare no_kb_needed', () => {
      const decision = computeEscalationDecision(
        payload({ cited_chunk_ids: [], confidence: 0.9 }),
        ZERO_CITATIONS,
        0,
        0.5,
      );

      expect(decision.compositeConfidence).toBe(0);
      expect(decision.escalate).toBe(true);
    });

    it('never waives the override for a fabricated citation, even with no_kb_needed set', () => {
      const decision = computeEscalationDecision(
        payload({
          cited_chunk_ids: ['chunk-99'],
          confidence: 0.95,
          no_kb_needed: true,
        }),
        FABRICATED_CITATIONS,
        0.95,
        0.5,
      );

      expect(decision.compositeConfidence).toBe(0);
      expect(decision.escalate).toBe(true);
      expect(decision.isHallucination).toBe(true);
    });

    it('is ignored when the model cited chunks anyway — the normal gate applies', () => {
      const decision = computeEscalationDecision(
        payload({ confidence: 0.9, no_kb_needed: true }),
        VALID_CITATIONS,
        0,
        0.5,
      );

      expect(decision.compositeConfidence).toBe(0);
      expect(decision.escalate).toBe(true);
    });
  });

  describe('distress the model acknowledged but did not act on (D12 net)', () => {
    it('escalates CUSTOMER_DISTRESS when a confident answer states the customer is upset', () => {
      const decision = computeEscalationDecision(
        payload({
          answer:
            'I understand you are frustrated with the service. Please send your order ID.',
          confidence: 0.9,
          escalate: false,
        }),
        VALID_CITATIONS,
        0.8,
        0.5,
      );

      expect(decision.escalate).toBe(true);
      expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
      expect(decision.escalationSource).toBe('agent_decision');
      // The answer is still good and still goes out alongside the handoff.
      expect(decision.compositeConfidence).toBe(0.9);
    });

    it('leaves an ordinary confident answer alone — polite apology is not distress', () => {
      const decision = computeEscalationDecision(
        payload({
          answer: 'Sorry for the inconvenience — your order ships in 2 days.',
          confidence: 0.9,
        }),
        VALID_CITATIONS,
        0.8,
        0.5,
      );

      expect(decision.escalate).toBe(false);
      expect(decision.escalationReason).toBeNull();
    });

    it('does not override a reason the model already chose', () => {
      const decision = computeEscalationDecision(
        payload({
          answer: 'You are clearly upset; let me get a colleague.',
          confidence: 0.9,
          escalate: true,
          escalation_reason: 'EXPLICIT_USER_REQUEST',
        }),
        VALID_CITATIONS,
        0.8,
        0.5,
      );

      expect(decision.escalationReason).toBe('EXPLICIT_USER_REQUEST');
    });
  });
});

// F17/A11/A12: D10 extended for non-text modalities. The tenant's threshold
// never moves for a photo or a voice note — what moves is our confidence when
// we could barely read what the customer sent.
describe('computeEscalationDecision() — modality confidence (F17)', () => {
  it('leaves a text turn identical: the default modality term is 1', () => {
    const withDefault = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      VALID_CITATIONS,
      0.6,
      0.5,
    );
    const withExplicitOne = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
    );

    expect(withExplicitOne).toEqual(withDefault);
  });

  it('caps the composite at how well the media was understood', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.95 }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      0.4,
    );

    expect(decision.compositeConfidence).toBeCloseTo(0.4);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('does not RAISE confidence when the media was understood perfectly', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.55 }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
    );

    expect(decision.compositeConfidence).toBeCloseTo(0.55);
    expect(decision.escalate).toBe(false);
  });

  it('keeps the zero-citation hard override ahead of the modality term — a perfectly heard question with no citation is still 0', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9, cited_chunk_ids: [] }),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
  });

  it('still flags a fabricated citation as a hallucination on a media turn', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9 }),
      FABRICATED_CITATIONS,
      0.6,
      0.5,
      undefined,
      0.9,
    );

    expect(decision.isHallucination).toBe(true);
    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });
});

describe('F27: customer-grievance signal (input side)', () => {
  it('relabels a supported, above-threshold escalation the model called CONFIDENCE_BELOW_THRESHOLD', () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.75,
        escalate: true,
        escalation_reason: 'CONFIDENCE_BELOW_THRESHOLD',
      }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
      true,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('relabels a below-threshold escalation, where the confidence label is an artefact of the zero-citation override', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9, escalate: false }),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
      true,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('escalates a confident answer the model chose not to hand off', () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.85,
        escalate: false,
        answer: 'سياسة الإرجاع 7 أيام.',
      }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
      true,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('never overrides a more specific reason the model named', () => {
    const decision = computeEscalationDecision(
      payload({
        confidence: 0.9,
        escalate: true,
        escalation_reason: 'EXPLICIT_USER_REQUEST',
      }),
      VALID_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
      true,
    );

    expect(decision.escalationReason).toBe('EXPLICIT_USER_REQUEST');
  });

  it('never overrides a fabricated citation: there the confidence failure is the real story', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9, escalate: false }),
      FABRICATED_CITATIONS,
      0.6,
      0.5,
      undefined,
      1,
      true,
    );

    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.isHallucination).toBe(true);
  });

  it('changes nothing when the signal is absent', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 0.9, escalate: false }),
      VALID_CITATIONS,
      0.6,
      0.5,
    );

    expect(decision.escalate).toBe(false);
    expect(decision.escalationReason).toBeNull();
  });
});

// Eval A1 (2026-09-29, commerce-lookup 75/75 turns escalated at confidence 0):
// on a KB-less tenant the model still put a handle like "c1" in cited_chunk_ids.
// With zero chunks retrieved a handle cannot refer to anything, so counting it
// "fabricated" zeroed correct, tool-grounded answers and set isHallucination.
describe('dropUnresolvableCitations()', () => {
  it('drops every cited handle when no chunk was retrieved and a tool ran', () => {
    const result = dropUnresolvableCitations(
      payload({ cited_chunk_ids: ['c1', 'c2'] }),
      0,
      true,
    );

    expect(result.cited_chunk_ids).toEqual([]);
  });

  it('does not mutate the input payload', () => {
    const input = payload({ cited_chunk_ids: ['c1'] });

    dropUnresolvableCitations(input, 0, true);

    expect(input.cited_chunk_ids).toEqual(['c1']);
  });

  it('keeps the citations when chunks WERE retrieved, so a non-existent handle stays fabricated', () => {
    const input = payload({ cited_chunk_ids: ['c1', 'c9'] });

    expect(dropUnresolvableCitations(input, 1, true)).toBe(input);
  });

  it('keeps the citations when no tool ran, so a KB-less citation with no evidence is still a hallucination', () => {
    const input = payload({ cited_chunk_ids: ['c1'] });

    expect(dropUnresolvableCitations(input, 0, false)).toBe(input);
  });

  it('turns a KB-less tool-grounded turn that cited "c1" into a waived, non-hallucination decision', () => {
    const raw = payload({ cited_chunk_ids: ['c1'], confidence: 0.9 });
    const effective = dropUnresolvableCitations(raw, 0, true);

    const decision = computeEscalationDecision(
      effective,
      verifyCitations(effective.cited_chunk_ids, []),
      0,
      0.5,
      undefined,
      1,
      false,
      true,
    );

    expect(decision.compositeConfidence).toBe(0.9);
    expect(decision.escalate).toBe(false);
    expect(decision.isHallucination).toBe(false);
  });

  it('still flags a fabricated handle among real chunks as a hallucination', () => {
    const raw = payload({ cited_chunk_ids: ['c1', 'c9'], confidence: 0.9 });
    const effective = dropUnresolvableCitations(raw, 1, true);

    const decision = computeEscalationDecision(
      effective,
      verifyCitations(effective.cited_chunk_ids, ['c1']),
      0.8,
      0.5,
      undefined,
      1,
      false,
      true,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.isHallucination).toBe(true);
  });
});

describe('cycle 3: an uncited answer no tool grounds does not score certainty (catering-quotes#13)', () => {
  const NOT_COVERED_ANSWER =
    'The provided information only covers catering services, menus, and pricing. It does not mention photography or stage decoration services.';

  it('escalates an uncited no_kb_needed answer that says the information does not cover the question', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: NOT_COVERED_ANSWER,
        cited_chunk_ids: [],
        confidence: 1,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('caps a legitimate uncited no_kb_needed answer below 1.0 without escalating it', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'Hello! How can I help you today?',
        cited_chunk_ids: [],
        confidence: 1,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(UNCITED_CONFIDENCE_CAP);
    expect(decision.compositeConfidence).toBeLessThan(1);
    expect(decision.escalate).toBe(false);
  });

  it('never caps below the tenant threshold, so a strict tenant does not hand every greeting to a human', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'Hello! How can I help you today?',
        cited_chunk_ids: [],
        confidence: 1,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.95,
    );

    expect(decision.compositeConfidence).toBe(0.95);
    expect(decision.escalate).toBe(false);
  });

  it('does not cap a cited answer', () => {
    const decision = computeEscalationDecision(
      payload({ confidence: 1 }),
      VALID_CITATIONS,
      0.8,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(1);
  });

  it('does not cap a tool-grounded answer', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'The Orbit V3 is in stock.',
        cited_chunk_ids: [],
        confidence: 1,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
      false,
      true,
    );

    expect(decision.compositeConfidence).toBe(1);
    expect(decision.escalate).toBe(false);
  });

  it('keeps a lower model confidence lower than the cap', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'Thanks!',
        cited_chunk_ids: [],
        confidence: 0.6,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0.6);
  });
});

describe('cycle 3: safety-risk signal (allergy / health risk always hands off)', () => {
  function decide(
    overrides: Partial<RespondPayload>,
    citations: CitationVerificationResult = VALID_CITATIONS,
    retrieval = 0.8,
    safetyRisk = true,
  ) {
    return computeEscalationDecision(
      payload(overrides),
      citations,
      retrieval,
      0.5,
      undefined,
      1,
      false,
      false,
      safetyRisk,
    );
  }

  it('escalates a confident, fully cited answer the model did not escalate (catering-quotes#7, missed 2 of 5)', () => {
    const decision = decide({ confidence: 1, escalate: false });

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('escalates a zero-citation no_kb_needed answer', () => {
    const decision = decide(
      { cited_chunk_ids: [], confidence: 1, no_kb_needed: true },
      ZERO_CITATIONS,
      0,
    );

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('replaces the model’s CUSTOMER_COMPLAINT label with the safety one', () => {
    const decision = decide({
      escalate: true,
      escalation_reason: 'CUSTOMER_COMPLAINT',
    });

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('keeps the more specific EXPLICIT_USER_REQUEST when the customer asked for a person', () => {
    const decision = decide({
      escalate: true,
      escalation_reason: 'EXPLICIT_USER_REQUEST',
    });

    expect(decision.escalationReason).toBe('EXPLICIT_USER_REQUEST');
  });

  it('still reports a fabricated citation as a hallucination while escalating', () => {
    const decision = decide({ confidence: 1 }, FABRICATED_CITATIONS, 0.9);

    expect(decision.escalate).toBe(true);
    expect(decision.isHallucination).toBe(true);
  });

  it('changes nothing when the signal is off', () => {
    const decision = decide({ confidence: 0.9 }, VALID_CITATIONS, 0.8, false);

    expect(decision.escalate).toBe(false);
  });
});

describe('cycle 3: late-delivery-complaint signal (complaint after track_order)', () => {
  function decide(
    overrides: Partial<RespondPayload>,
    lateDeliveryComplaint = true,
    customerGrievance = false,
  ) {
    return computeEscalationDecision(
      payload(overrides),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
      customerGrievance,
      true,
      false,
      lateDeliveryComplaint,
    );
  }

  it('escalates a tool-grounded status answer with CUSTOMER_COMPLAINT (commerce-complaint#6, missed 3 of 3)', () => {
    const decision = decide({
      answer: 'Your shipment is out for delivery.',
      cited_chunk_ids: [],
      confidence: 1,
    });

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CUSTOMER_COMPLAINT');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('relabels a model escalation that named CONFIDENCE_BELOW_THRESHOLD', () => {
    const decision = decide({
      cited_chunk_ids: [],
      escalate: true,
      escalation_reason: 'CONFIDENCE_BELOW_THRESHOLD',
    });

    expect(decision.escalationReason).toBe('CUSTOMER_COMPLAINT');
  });

  it('keeps a specific reason the model already chose', () => {
    const decision = decide({
      cited_chunk_ids: [],
      escalate: true,
      escalation_reason: 'CUSTOMER_DISTRESS',
    });

    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('lets a grievance (the customer’s state) keep CUSTOMER_DISTRESS', () => {
    const decision = decide({ cited_chunk_ids: [], confidence: 1 }, true, true);

    expect(decision.escalationReason).toBe('CUSTOMER_DISTRESS');
  });

  it('does not escalate a tool-grounded answer when the signal is off', () => {
    const decision = decide({ cited_chunk_ids: [], confidence: 1 }, false);

    expect(decision.escalate).toBe(false);
  });
});

describe('cycle 3b: a clarifying question is a no-KB turn, an uncited figure is not (khaleeji#0, egyptian#1)', () => {
  it('does not zero an uncited clarifying question to an ambiguous price question', () => {
    const decision = computeEscalationDecision(
      payload({
        answer:
          'هل تقصد سماعات SmartPro X1 أم SmartPro X1 Pro؟ أخبرني لأعطيك السعر.',
        cited_chunk_ids: [],
        confidence: 0.9,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0.9);
    expect(decision.escalate).toBe(false);
  });

  it('still zeroes an uncited no_kb_needed answer that states a price', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'The SmartPro X1 is 4,500 SAR. Which one do you want?',
        cited_chunk_ids: [],
        confidence: 0.9,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
  });

  it('still zeroes an uncited no_kb_needed answer that states a number of days', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'You can return it within 7 days.',
        cited_chunk_ids: [],
        confidence: 1,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
    );

    expect(decision.compositeConfidence).toBe(0);
    expect(decision.escalate).toBe(true);
  });

  it('leaves a tool-grounded answer with figures alone (it is judged on its tool results)', () => {
    const decision = computeEscalationDecision(
      payload({
        answer: 'The kettle is 149 SAR and in stock.',
        cited_chunk_ids: [],
        confidence: 0.9,
        no_kb_needed: true,
      }),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
      false,
      true,
    );

    expect(decision.escalate).toBe(false);
  });
});

describe('cycle 3b: track_order found no shipment (commerce-tracking#14)', () => {
  const REFUSAL = {
    answer: 'I could not find a shipment with that number on your account.',
    cited_chunk_ids: [],
    confidence: 1,
    escalate: false,
  };

  function decide(
    overrides: Partial<RespondPayload>,
    shipmentNotFound: boolean,
  ) {
    return computeEscalationDecision(
      payload({ ...REFUSAL, ...overrides }),
      ZERO_CITATIONS,
      0,
      0.5,
      undefined,
      1,
      false,
      true,
      false,
      false,
      shipmentNotFound,
    );
  }

  it('escalates a tool-grounded answer when no shipment was found and the model did not hand off', () => {
    const decision = decide({}, true);

    expect(decision.escalate).toBe(true);
    expect(decision.escalationReason).toBe('KB_NOT_INDEXED');
    expect(decision.escalationSource).toBe('agent_decision');
  });

  it('keeps the model reason when it escalated itself', () => {
    const decision = decide(
      { escalate: true, escalation_reason: 'CUSTOMER_COMPLAINT' },
      true,
    );

    expect(decision.escalationReason).toBe('CUSTOMER_COMPLAINT');
  });

  it('does nothing when a shipment was found', () => {
    expect(decide({}, false).escalate).toBe(false);
  });
});

