import {
  buildGroundingMessages,
  parseGroundingVerdict,
  toolResultFacts,
} from './answer-grounding';

describe('toolResultFacts (cycle 3b, commerce-tracking#18)', () => {
  it('drops the agent-facing guidance key and keeps every fact', () => {
    const facts = toolResultFacts(
      JSON.stringify({
        shipments: [{ status: 'out_for_delivery' }],
        guidance: '"out for delivery" is not "arriving today"',
      }),
    );

    expect(facts).toBe('{"shipments":[{"status":"out_for_delivery"}]}');
  });

  it('keeps customerMessage, the result\'s own outcome token', () => {
    const facts = toolResultFacts(
      JSON.stringify({ status: 'pending', customerMessage: 'awaiting_team' }),
    );

    expect(facts).toContain('awaiting_team');
  });

  it.each(['not json', '[1,2]', '"a string"'])(
    'passes a non-object result through unchanged: %s',
    (raw) => {
      expect(toolResultFacts(raw)).toBe(raw);
    },
  );

  it('is what the checker is shown', () => {
    const user = buildGroundingMessages({
      question: 'q',
      answer: 'a',
      citedPassages: [],
      toolResultPassages: [JSON.stringify({ status: 'x', guidance: 'SECRET' })],
    })[1] as { content: string };

    expect(user.content).toContain('[tool result 1]\n{"status":"x"}');
    expect(user.content).not.toContain('SECRET');
  });
});

describe('parseGroundingVerdict', () => {
  it.each([
    ['COVERED', 'COVERED'],
    ['covered', 'COVERED'],
    ['COVERED.', 'COVERED'],
    ['NOT_COVERED', 'NOT_COVERED'],
    ['not covered', 'NOT_COVERED'],
    ['NOT-COVERED', 'NOT_COVERED'],
    ['CONFLICT', 'CONFLICT'],
  ])('reads %j as %s', (text, expected) => {
    expect(parseGroundingVerdict(text)).toBe(expected);
  });

  // The one failure mode this net cannot afford: NOT_COVERED contains the
  // substring COVERED, so a naive `includes('COVERED')` would read every
  // caught case as a pass and silently disable the guard.
  it('never reads NOT_COVERED as COVERED', () => {
    expect(parseGroundingVerdict('NOT_COVERED')).not.toBe('COVERED');
  });

  it('has no opinion on a hedge naming two verdicts', () => {
    expect(
      parseGroundingVerdict('COVERED, but there is a CONFLICT'),
    ).toBeNull();
  });

  it('reads only the VERDICT line when the reply carries check lines (cycle 3b)', () => {
    expect(
      parseGroundingVerdict(
        'ITEM: headphones, 12,900 BDT\nCONDITIONS: EMI above 15,000, so not NOT_COVERED by mistake\nCLAIMS: no CONFLICT\nVERDICT: COVERED',
      ),
    ).toBe('COVERED');
    expect(
      parseGroundingVerdict(
        'ITEM: x\nCONDITIONS: none\nCLAIMS: looks COVERED at first\nVERDICT: NOT_COVERED',
      ),
    ).toBe('NOT_COVERED');
  });

  it('has no opinion when the reply was cut off before its VERDICT line names a verdict', () => {
    expect(
      parseGroundingVerdict('ITEM: x\nCONDITIONS: none\nVERDICT:'),
    ).toBeNull();
  });

  it.each(['', 'maybe', 'I cannot determine that', 'VERDICT | unsupported'])(
    'has no opinion on %j',
    (text) => {
      expect(parseGroundingVerdict(text)).toBeNull();
    },
  );
});

describe('buildGroundingMessages', () => {
  const input = {
    question: 'do I need an appointment for a blood test',
    answer: 'Yes, you need an appointment for a blood test.',
    citedPassages: ['Consultations require an appointment.', 'Open 9-5.'],
  };

  it('sends a system rule set plus one user message carrying question, answer and passages', () => {
    const messages = buildGroundingMessages(input);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    const user = messages[1] as { content: string };
    expect(user.content).toContain(input.question);
    expect(user.content).toContain(input.answer);
    expect(user.content).toContain('Consultations require an appointment.');
    expect(user.content).toContain('Open 9-5.');
  });

  it('numbers the passages so the checker can tell two apart (the CONFLICT verdict needs that)', () => {
    const user = buildGroundingMessages(input)[1] as { content: string };

    expect(user.content).toContain('[passage 1]');
    expect(user.content).toContain('[passage 2]');
  });

  it('asks for three check lines then a VERDICT line, and names all three verdicts (cycle 3b)', () => {
    const system = buildGroundingMessages(input)[0] as { content: string };

    expect(system.content).toContain('COVERED');
    expect(system.content).toContain('NOT_COVERED');
    expect(system.content).toContain('CONFLICT');
    expect(system.content).toContain('ITEM:');
    expect(system.content).toContain('CONDITIONS:');
    expect(system.content).toContain('CLAIMS:');
    expect(system.content).toContain(
      'VERDICT: <COVERED or NOT_COVERED or CONFLICT>',
    );
  });

  describe('cycle 3b prompt contract', () => {
    const system = (buildGroundingMessages(input)[0] as { content: string })
      .content;

    it('checks comparisons and calculations, not only that premises exist (multi-doc#3 EMI)', () => {
      expect(system).toMatch(/AND the conclusion is correct/);
      expect(system).toMatch(/Check every comparison and calculation yourself/);
    });

    it('requires a threshold that changes the stated value to be applied (multi-doc#2)', () => {
      expect(system).toMatch(/leaving the condition out is not a harmless omission/);
    });

    it('treats an uncited source without the exception as CONFLICT (conflicting-docs#3)', () => {
      expect(system).toMatch(/One-sided exceptions/);
      expect(system).toMatch(/cited or uncited/);
    });

    it('rejects a rule carried across to the mirrored party (catering-policies#13)', () => {
      expect(system).toMatch(/Mirrored rules/);
    });
  });

  it('truncates per passage, so one huge chunk cannot crowd the others out', () => {
    const user = buildGroundingMessages({
      ...input,
      citedPassages: ['x'.repeat(5000), 'the second passage'],
    })[1] as { content: string };

    expect(user.content).not.toContain('x'.repeat(2001));
    expect(user.content).toContain('the second passage');
  });

  // A3 (full-qwen eval): 48 L1 false escalations came from the verifier
  // reading legitimately grounded answers as NOT_COVERED. One test per class.
  describe('A3 false-escalation classes (prompt contract)', () => {
    const system = (buildGroundingMessages(input)[0] as { content: string })
      .content;

    it('class 3: treats tool results as authoritative sources equal to KB passages', () => {
      expect(system).toContain('[tool result');
      expect(system).toMatch(/tool results? (are|is) authoritative/i);
      expect(system).toMatch(/equal(ly)? .*knowledge-base passages/i);
    });

    it('class 1: a not-available / not-listed answer derived from a complete list is COVERED', () => {
      expect(system).toMatch(/complete list/i);
      expect(system).toMatch(/not listed|not available/i);
      expect(system).toMatch(/closed list/i);
    });

    it('class 2: summarising or comparing options present in the passages is COVERED', () => {
      expect(system).toMatch(/summaris(es|ing)|compar(es|ing)/i);
      expect(system).toMatch(/named no (specific )?product/i);
    });

    it('class 4: an answer with no factual claim (refusal, clarifying question, handoff) is COVERED', () => {
      expect(system).toMatch(/clarifying question/i);
      expect(system).toMatch(/hand-?off|connecting/i);
      expect(system).toMatch(/refus/i);
    });

    it('keeps the real protections: a different product or service stays NOT_COVERED, conflicts stay CONFLICT', () => {
      expect(system).toMatch(/different (product|service)/i);
      expect(system).toContain('NOT_COVERED');
      expect(system).toContain('CONFLICT');
      expect(system).toContain('diagnostic tests');
    });
  });

  describe('tool result labelling', () => {
    it('labels tool-result passages distinctly from knowledge-base passages', () => {
      const user = buildGroundingMessages({
        ...input,
        toolResultPassages: ['{"status":"shipped"}', '{"price":"AED 99"}'],
      })[1] as { content: string };

      expect(user.content).toContain('[passage 1]');
      expect(user.content).toContain('[passage 2]');
      expect(user.content).toContain('[tool result 1]\n{"status":"shipped"}');
      expect(user.content).toContain('[tool result 2]\n{"price":"AED 99"}');
    });

    it('truncates tool results per item like passages', () => {
      const user = buildGroundingMessages({
        ...input,
        toolResultPassages: ['y'.repeat(5000), 'second tool result'],
      })[1] as { content: string };

      expect(user.content).not.toContain('y'.repeat(4001));
      expect(user.content).toContain('second tool result');
    });

    // A create_order / track_order row carries guidance text before the facts
    // the answer quotes; the passage cap cut them off (cycle 3).
    it('keeps a tool result longer than the passage cap, so a fact deep in the JSON stays visible', () => {
      const user = buildGroundingMessages({
        ...input,
        toolResultPassages: [`${'z'.repeat(2500)}"orderReference":"ORD-42"`],
      })[1] as { content: string };

      expect(user.content).toContain('"orderReference":"ORD-42"');
    });

    it('renders no tool-result label when there are none', () => {
      const user = buildGroundingMessages(input)[1] as { content: string };
      expect(user.content).not.toContain('[tool result');
    });
  });

  describe('uncited retrieved passages (multi-chunk inference)', () => {
    it('labels retrieved-but-uncited passages distinctly and after the cited ones', () => {
      const user = buildGroundingMessages({
        ...input,
        otherRetrievedPassages: ['EMI applies above 15,000 BDT.'],
      })[1] as { content: string };

      expect(user.content).toContain(
        '[uncited passage 1]\nEMI applies above 15,000 BDT.',
      );
      expect(user.content.indexOf('[passage 2]')).toBeLessThan(
        user.content.indexOf('[uncited passage 1]'),
      );
    });

    it('caps how many uncited passages are sent', () => {
      const user = buildGroundingMessages({
        ...input,
        otherRetrievedPassages: Array.from({ length: 20 }, (_, i) => `p${i}`),
      })[1] as { content: string };

      expect(user.content).toContain('[uncited passage 6]');
      expect(user.content).not.toContain('[uncited passage 7]');
    });

    it('renders no uncited label when there are none', () => {
      const user = buildGroundingMessages(input)[1] as { content: string };
      expect(user.content).not.toContain('[uncited passage');
    });
  });

  // Cycle 3 (2026-09-30): ~34 grounded turns overridden. Widening what counts
  // as grounding must not turn the net off — one test per side.
  describe('cycle-3 prompt contract', () => {
    const system = (buildGroundingMessages(input)[0] as { content: string })
      .content;

    it('counts create_order and track_order results as grounding for order and tracking answers', () => {
      expect(system).toMatch(/create_order/);
      expect(system).toMatch(/track_order/);
      expect(system).toMatch(/order reference/i);
      expect(system).toMatch(/estimated delivery/i);
    });

    it('treats a not-found tool result as grounding for "I could not find it"', () => {
      expect(system).toMatch(/not found/i);
    });

    it('accepts inference across passages when every premise is stated (EMI threshold vs price, exception applied to an item)', () => {
      expect(system).toMatch(/inference across sources/i);
      expect(system).toMatch(/threshold/i);
      expect(system).toMatch(/several passages/i);
    });

    it('names the uncited passage label as a legitimate source', () => {
      expect(system).toContain('[uncited passage N]');
    });

    it('still demands NOT_COVERED for a fact that appears in no source, tool results included', () => {
      expect(system).toMatch(/invented fact/i);
      expect(system).toMatch(/NO source/);
      expect(system).toMatch(/no passage and no tool result/i);
      expect(system).toMatch(/even when the rest of the answer is supported/i);
    });
  });
});
