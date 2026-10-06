import { parseRespondPayload } from './respond-payload.schema';

describe('parseRespondPayload()', () => {
  it('accepts a well-formed non-escalating payload', () => {
    const result = parseRespondPayload({
      answer: 'Your order ships in 3-5 days.',
      cited_chunk_ids: ['chunk-1'],
      confidence: 0.9,
      escalate: false,
    });

    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed escalating payload with an escalation_reason', () => {
    const result = parseRespondPayload({
      answer: 'Let me connect you with a human.',
      cited_chunk_ids: [],
      confidence: 0,
      escalate: true,
      escalation_reason: 'CONFIDENCE_BELOW_THRESHOLD',
    });

    expect(result.ok).toBe(true);
  });

  it('rejects escalate: true without an escalation_reason', () => {
    const result = parseRespondPayload({
      answer: 'x',
      cited_chunk_ids: [],
      confidence: 0,
      escalate: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain(
        'escalation_reason is required',
      );
    }
  });

  it('rejects an empty answer', () => {
    const result = parseRespondPayload({
      answer: '',
      cited_chunk_ids: [],
      confidence: 0.5,
      escalate: false,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects confidence outside [0, 1]', () => {
    const result = parseRespondPayload({
      answer: 'x',
      cited_chunk_ids: [],
      confidence: 1.5,
      escalate: false,
    });

    expect(result.ok).toBe(false);
  });

  it('rejects an unrecognized escalation_reason value', () => {
    const result = parseRespondPayload({
      answer: 'x',
      cited_chunk_ids: [],
      confidence: 0,
      escalate: true,
      escalation_reason: 'NOT_A_REAL_REASON',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a non-object payload without throwing', () => {
    const result = parseRespondPayload('not an object');

    expect(result.ok).toBe(false);
  });

  it('rejects a payload missing required fields', () => {
    const result = parseRespondPayload({ answer: 'x' });

    expect(result.ok).toBe(false);
  });
});
