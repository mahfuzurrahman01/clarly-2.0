import { parseRespondPayloadFromText } from './respond-text-fallback';

describe('parseRespondPayloadFromText', () => {
  it('recovers the exact shape measured in the eval: prose answer followed by field lines', () => {
    // Verbatim from the 2026-08-16 multi-doc-synthesis failure (3/3 runs).
    const content =
      'The Asus Vivobook 15 costs 82,000 BDT. According to our payment policy, cash on ' +
      'delivery is only available for orders up to 50,000 BDT.\n\n' +
      'cited_chunk_ids: ["c1", "c2"]\nconfidence: 1.0\nescalate: false';

    const payload = parseRespondPayloadFromText(content);

    expect(payload).not.toBeNull();
    expect(payload?.answer).toContain('50,000 BDT');
    expect(payload?.answer).not.toContain('cited_chunk_ids');
    expect(payload?.cited_chunk_ids).toEqual(['c1', 'c2']);
    expect(payload?.confidence).toBe(1);
    expect(payload?.escalate).toBe(false);
  });

  it('recovers the pseudo-XML shape the model produced on its second attempt', () => {
    const content =
      '<respond>\n<answer>\nWe deliver in 3 days.\n</answer>\n' +
      '<cited_chunk_ids>\n["c1"]\n</cited_chunk_ids>\n' +
      '<confidence>\n0.9\n</confidence>\n<escalate>\nfalse\n</escalate>\n</respond>';

    const payload = parseRespondPayloadFromText(content);

    expect(payload).toEqual({
      answer: 'We deliver in 3 days.',
      cited_chunk_ids: ['c1'],
      confidence: 0.9,
      escalate: false,
    });
  });

  it('recovers a Hermes/Qwen <tool_call> envelope the serving host failed to parse', () => {
    const content =
      'thinking…\n<tool_call>\n{"name": "respond", "arguments": {"answer": "Yes.", ' +
      '"cited_chunk_ids": ["c2"], "confidence": 0.8, "escalate": false}}\n</tool_call>';

    expect(parseRespondPayloadFromText(content)).toEqual({
      answer: 'Yes.',
      cited_chunk_ids: ['c2'],
      confidence: 0.8,
      escalate: false,
    });
  });

  it('recovers a fenced JSON object', () => {
    const content =
      'Here you go:\n```json\n{"answer":"Open at 9am","cited_chunk_ids":["c1"],' +
      '"confidence":0.95,"escalate":false,"no_kb_needed":false}\n```';

    const payload = parseRespondPayloadFromText(content);

    expect(payload?.answer).toBe('Open at 9am');
    expect(payload?.no_kb_needed).toBe(false);
  });

  it('carries an escalation through with its reason', () => {
    const content =
      'I will connect you with a colleague.\n' +
      'cited_chunk_ids: []\nconfidence: 0.4\nescalate: true\n' +
      'escalation_reason: CUSTOMER_DISTRESS';

    const payload = parseRespondPayloadFromText(content);

    expect(payload?.escalate).toBe(true);
    expect(payload?.escalation_reason).toBe('CUSTOMER_DISTRESS');
  });

  it('returns null for an ordinary plain-text reply — the corrective retry must still happen', () => {
    expect(
      parseRespondPayloadFromText(
        'Sure, here is an answer without calling respond.',
      ),
    ).toBeNull();
    expect(parseRespondPayloadFromText('')).toBeNull();
  });

  it('returns null for a PARTIAL payload rather than inventing the missing fields', () => {
    // The third call in the measured failure: `answer` only. Nothing may be
    // defaulted here — an assumed confidence of 1 or escalate:false would be a
    // fabricated self-report.
    expect(
      parseRespondPayloadFromText('answer: The laptop costs 82,000 BDT.'),
    ).toBeNull();
    expect(
      parseRespondPayloadFromText(
        'Yes we do.\ncited_chunk_ids: ["c1"]\nconfidence: 0.9',
      ),
    ).toBeNull();
  });

  it('returns null when a field is present but unreadable, instead of guessing it', () => {
    expect(
      parseRespondPayloadFromText(
        'Yes.\ncited_chunk_ids: ["c1"]\nconfidence: high\nescalate: false',
      ),
    ).toBeNull();
    expect(
      parseRespondPayloadFromText(
        'Yes.\ncited_chunk_ids: ["c1"]\nconfidence: 0.9\nescalate: maybe',
      ),
    ).toBeNull();
  });

  it('rejects a payload that escalates without naming a reason (same refine as the tool path)', () => {
    expect(
      parseRespondPayloadFromText(
        'Let me get a human.\ncited_chunk_ids: []\nconfidence: 0.2\nescalate: true',
      ),
    ).toBeNull();
  });

  it('rejects an out-of-range confidence rather than clamping it', () => {
    expect(
      parseRespondPayloadFromText(
        'Yes.\ncited_chunk_ids: ["c1"]\nconfidence: 5\nescalate: false',
      ),
    ).toBeNull();
  });

  it('accepts an explicitly empty citation list', () => {
    const payload = parseRespondPayloadFromText(
      'Hello!\ncited_chunk_ids: []\nconfidence: 1\nescalate: false\nno_kb_needed: true',
    );

    expect(payload?.cited_chunk_ids).toEqual([]);
    expect(payload?.no_kb_needed).toBe(true);
  });

  it('reads an unquoted, comma-separated citation list', () => {
    const payload = parseRespondPayloadFromText(
      'Yes.\ncited_chunk_ids: c1, c2\nconfidence: 0.7\nescalate: false',
    );

    expect(payload?.cited_chunk_ids).toEqual(['c1', 'c2']);
  });

  // Cycle 3b (commerce-lookup#13, 1 of 3 runs): Qwen's XML tool-call format,
  // missed by the serving host's parser, ended deadline_exceeded_after_tool.
  it('reads the Qwen XML parameter format (<tool_call>respond <parameter=...>)', () => {
    const content = [
      '<tool_call>respond',
      '<parameter=answer>',
      'We have the Acme X200 Blender at 199.00 SAR.',
      '</parameter>',
      '<parameter=cited_chunk_ids>',
      '["c1"]',
      '</parameter>',
      '<parameter=confidence>',
      '1',
      '</parameter>',
      '<parameter=escalate>',
      'false',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');

    expect(parseRespondPayloadFromText(content)).toEqual({
      answer: 'We have the Acme X200 Blender at 199.00 SAR.',
      cited_chunk_ids: ['c1'],
      confidence: 1,
      escalate: false,
    });
  });

  it('reads the <function=respond> variant of the same format', () => {
    const content =
      '<tool_call>\n<function=respond>\n<parameter=answer>\nHello!\n</parameter>\n<parameter=cited_chunk_ids>\n[]\n</parameter>\n<parameter=confidence>\n0.9\n</parameter>\n<parameter=escalate>\nfalse\n</parameter>\n<parameter=no_kb_needed>\ntrue\n</parameter>\n</function>\n</tool_call>';

    expect(parseRespondPayloadFromText(content)).toMatchObject({
      answer: 'Hello!',
      no_kb_needed: true,
    });
  });

  it('ignores the XML parameter format for a tool other than respond', () => {
    const content =
      '<tool_call>lookup_product\n<parameter=query>\nkettle\n</parameter>\n</tool_call>';

    expect(parseRespondPayloadFromText(content)).toBeNull();
  });

  it('still rejects an incomplete XML parameter payload', () => {
    const content =
      '<tool_call>respond\n<parameter=answer>\nHi\n</parameter>\n</tool_call>';

    expect(parseRespondPayloadFromText(content)).toBeNull();
  });
});

