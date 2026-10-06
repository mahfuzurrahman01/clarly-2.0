import type { AppLoggerService } from '../core';
import type { LlmProvider } from '../llm/ports/llm-provider.port';
import { AnswerGroundingVerifierService } from './answer-grounding-verifier.service';

function makeService(complete: jest.Mock): {
  service: AnswerGroundingVerifierService;
  warn: jest.Mock;
} {
  const warn = jest.fn();
  const service = new AnswerGroundingVerifierService(
    { complete } as unknown as LlmProvider,
    { warn } as unknown as AppLoggerService,
  );
  return { service, warn };
}

function completion(content: string) {
  return {
    content,
    stopReason: 'end_turn' as const,
    usage: { inputTokens: 700, outputTokens: 2 },
  };
}

const INPUT = {
  question: 'do I need an appointment for a blood test',
  answer: 'Yes, you need an appointment for a blood test.',
  citedPassages: ['Consultations require an appointment.'],
};

describe('AnswerGroundingVerifierService', () => {
  it('returns the parsed verdict and the call’s token usage', async () => {
    const { service } = makeService(
      jest.fn().mockResolvedValue(completion('NOT_COVERED')),
    );

    await expect(service.check(INPUT)).resolves.toEqual({
      verdict: 'NOT_COVERED',
      usage: { inputTokens: 700, outputTokens: 2 },
    });
  });

  it('pins temperature to 0 — a guard must not change its mind between identical turns', async () => {
    const complete = jest.fn().mockResolvedValue(completion('COVERED'));
    const { service } = makeService(complete);

    await service.check(INPUT);

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0, maxTokens: 400 }),
    );
  });

  // Property 1 of this service: fail open. A verifier outage must never become
  // an escalation storm.
  it('has no opinion (and does not throw) when the provider fails', async () => {
    const { service, warn } = makeService(
      jest.fn().mockRejectedValue(new Error('LLM_TIMEOUT: timed out')),
    );

    await expect(service.check(INPUT)).resolves.toEqual({
      verdict: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('has no opinion on an unparseable reply, but still reports what it cost', async () => {
    const { service, warn } = makeService(
      jest.fn().mockResolvedValue(completion('I think it is fine?')),
    );

    await expect(service.check(INPUT)).resolves.toEqual({
      verdict: null,
      usage: { inputTokens: 700, outputTokens: 2 },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('never calls the provider when nothing was cited', async () => {
    const complete = jest.fn();
    const { service } = makeService(complete);

    await expect(
      service.check({ ...INPUT, citedPassages: [] }),
    ).resolves.toEqual({
      verdict: null,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(complete).not.toHaveBeenCalled();
  });

  // A3: an answer built only from tool results (tracking status, catalog rows)
  // has zero cited chunks but is still checkable.
  it('checks tool-result-only grounding instead of skipping it', async () => {
    const complete = jest.fn().mockResolvedValue(completion('COVERED'));
    const { service } = makeService(complete);

    await expect(
      service.check({
        ...INPUT,
        citedPassages: [],
        toolResultPassages: ['{"status":"shipped"}'],
      }),
    ).resolves.toEqual({
      verdict: 'COVERED',
      usage: { inputTokens: 700, outputTokens: 2 },
    });
    const messages = (
      complete.mock.calls[0] as [{ messages: { content: string }[] }]
    )[0].messages;
    expect(messages[1].content).toContain('[tool result 1]');
  });
});
