// F17 (A11/A12) at the level that matters: a turn that arrived as a photo or a
// voice note goes through the SAME pipeline a typed question does — retrieval,
// the D12 forbidden-topic check, the prompt, the bounded loop, citation
// verification, D10's composite confidence — and media we cannot read ends as a
// clean UNSUPPORTED_MEDIA escalation rather than a crash, a hang, or silence.
import { MediaUnreadable, TranscriptionFailed } from '@repo/errors';
import type { Clock } from '../core/clock/clock';
import type { AppConfigService } from '../core/config/app-config.service';
import type { AppLoggerService } from '../core/logger/app-logger.service';
import type { ConversationService } from '../conversation/conversation.service';
import type { AnswerGroundingVerifierService } from '../guardrail/answer-grounding-verifier.service';
import type { ForbiddenTopicCheckerService } from '../guardrail/forbidden-topic-checker.service';
import type {
  LlmProvider,
  LlmToolResult,
  VisionLlmProvider,
} from '../llm/ports/llm-provider.port';
import type {
  RetrievalSearchResult,
  RetrievalSearchService,
} from '../retrieval/retrieval-search.service';
import type { TenantToolRegistryService } from '../tool-registry/tenant-tool-registry.service';
import type { ToolExecutionService } from '../tool-execution/tool-execution.service';
import { AgentRuntime } from './agent-runtime';
import type { MediaUnderstandingService } from './media/media-understanding.service';
import type { MediaUnderstanding, TurnMedia } from './media/turn-media.dto';
import { RESPOND_TOOL_NAME } from './respond-tool-definition';
import type { AgentTurnInput } from './agent-turn.dto';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)]);

const RETRIEVAL_RESULT: RetrievalSearchResult = {
  chunks: [
    {
      id: 'chunk-1',
      content: 'The Acme X200 blender costs 4500 BDT.',
      score: 0.9,
    },
    { id: 'chunk-2', content: 'Shipping takes 3-5 days.', score: 0.8 },
  ],
  queryEmbedding: [0.1, 0.2],
  timings: {
    embedMs: 3,
    vectorQueryMs: 2,
    lexicalQueryMs: 1,
    fusionMs: 1,
    storeMs: 2,
    rerankMs: 0,
    totalMs: 10,
  },
};

function respondResult(payload: Record<string, unknown>): LlmToolResult {
  return {
    content: '',
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    toolCalls: [{ id: 'call-1', name: RESPOND_TOOL_NAME, input: payload }],
  };
}

const IMAGE_MEDIA: TurnMedia = {
  kind: 'image',
  mimeType: 'image/jpeg',
  bytes: JPEG,
  messageId: 'message-1',
};
const VOICE_MEDIA: TurnMedia = {
  kind: 'voice',
  mimeType: 'audio/ogg',
  bytes: OGG,
  messageId: 'message-2',
};

function makeInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return {
    tenantId: 'tenant-a',
    conversationSummary: null,
    recentMessages: [],
    currentMessage: '',
    tenantPolicy: {
      tonePersonaOverride: null,
      forbiddenTopics: [],
      confidenceThreshold: 0.5,
      rerankEnabled: false,
    },
    ...overrides,
  };
}

function makeTickingClock(): () => number {
  let now = 0;
  return () => (now += 1);
}

function makeHarness(opts: {
  completeWithTools: jest.Mock;
  understanding?: MediaUnderstanding;
  understandError?: Error;
  search?: jest.Mock;
}) {
  const understand = opts.understandError
    ? jest.fn().mockRejectedValue(opts.understandError)
    : jest.fn().mockResolvedValue(
        opts.understanding ?? {
          derivedText: '',
          images: [],
          confidence: 1,
          transcripts: [],
        },
      );
  const search = opts.search ?? jest.fn().mockResolvedValue(RETRIEVAL_RESULT);
  const assemble = jest.fn((input: { currentMessage: string }) => ({
    messages: [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: input.currentMessage },
    ],
    tools: [],
    promptVersion: 'v11',
  }));
  const forbiddenCheck = jest
    .fn()
    .mockResolvedValue({ isForbidden: false, topic: null });
  const visionCompleteWithTools = jest.fn(opts.completeWithTools);

  const runtime = new AgentRuntime(
    { assemble },
    { completeWithTools: opts.completeWithTools } as unknown as LlmProvider,
    {
      completeWithTools: visionCompleteWithTools,
      supportsVision: () => true,
    } as unknown as VisionLlmProvider,
    { understand } as unknown as MediaUnderstandingService,
    { search } as unknown as RetrievalSearchService,
    { check: forbiddenCheck } as unknown as ForbiddenTopicCheckerService,
    {
      check: jest.fn().mockResolvedValue({
        verdict: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    } as unknown as AnswerGroundingVerifierService,
    {
      getPromptToolSchemas: jest.fn().mockResolvedValue([]),
    } as unknown as TenantToolRegistryService,
    {
      authorize: jest.fn(),
      execute: jest.fn(),
    } as unknown as ToolExecutionService,
    {
      saveMediaTranscripts: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConversationService,
    {
      agentLoopDeadlineMs: 30_000,
      agentGroundingCheckEnabled: false,
    } as unknown as AppConfigService,
    // Advances 1ms per read, so a stage that ran records a non-zero span —
    // AgentRunTelemetry drops zero spans, which is exactly the "not measured"
    // vs "took 0ms" distinction agent-runs.table.ts documents.
    { nowMs: makeTickingClock() } as unknown as Clock,
    { wait: jest.fn().mockResolvedValue(undefined) },
    { warn: jest.fn(), error: jest.fn() } as unknown as AppLoggerService,
  );

  return {
    runtime,
    understand,
    search,
    assemble,
    forbiddenCheck,
    visionCompleteWithTools,
  };
}

describe('A11 — a product photo is answered like a text question', () => {
  const imageUnderstanding: MediaUnderstanding = {
    derivedText:
      'The customer sent an image. Automatic description of what it shows:\n<untrusted_image_description>\nAn Acme X200 blender\n</untrusted_image_description>',
    images: [{ mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64') }],
    confidence: 0.95,
    transcripts: [],
  };

  it('produces a cited answer at the same confidence bar as text', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'The Acme X200 costs 4500 BDT.',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime } = makeHarness({
      completeWithTools,
      understanding: imageUnderstanding,
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: 'how much is this?', media: [IMAGE_MEDIA] }),
    );

    expect(result.escalate).toBe(false);
    expect(result.citedChunkIds).toEqual(['chunk-1']);
    // min(model 0.9, modality 0.95) — the tenant threshold (0.5) is unchanged.
    expect(result.confidence).toBeCloseTo(0.9);
  });

  it('searches the knowledge base with the image description, not an empty query', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime, search, assemble } = makeHarness({
      completeWithTools,
      understanding: imageUnderstanding,
    });

    await runtime.respond(
      makeInput({ currentMessage: '', media: [IMAGE_MEDIA] }),
    );

    const [, imageQuery] = search.mock.calls[0] as [string, string];
    expect(imageQuery).toContain('Acme X200 blender');
    expect(assemble.mock.calls[0][0].currentMessage).toContain(
      '<untrusted_image_description>',
    );
  });

  it('runs the turn on the vision binding with the image attached to the user turn', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'ok',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const { runtime, visionCompleteWithTools } = makeHarness({
      completeWithTools,
      understanding: imageUnderstanding,
    });

    await runtime.respond(
      makeInput({ currentMessage: 'what is this?', media: [IMAGE_MEDIA] }),
    );

    const request = visionCompleteWithTools.mock.calls[0][0] as {
      messages: Array<{ role: string; attachments?: unknown[] }>;
    };
    const userMessage = request.messages.at(-1)!;
    expect(userMessage.role).toBe('user');
    expect(userMessage.attachments).toHaveLength(1);
  });

  it('applies the same D12 forbidden-topic check to what the image says', async () => {
    const completeWithTools = jest.fn();
    const { runtime, forbiddenCheck } = makeHarness({
      completeWithTools,
      understanding: imageUnderstanding,
    });
    forbiddenCheck.mockResolvedValue({ isForbidden: true, topic: 'medical' });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [IMAGE_MEDIA] }),
    );

    expect(result.escalationReason).toBe('FORBIDDEN_TOPIC');
    expect(result.escalationSource).toBe('agent_decision');
    expect(completeWithTools).not.toHaveBeenCalled();
  });

  it('forces confidence to 0 and escalates when the image answer cites nothing valid', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'It is a blender.',
        cited_chunk_ids: ['c9'],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeHarness({
      completeWithTools,
      understanding: imageUnderstanding,
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [IMAGE_MEDIA] }),
    );

    expect(result.confidence).toBe(0);
    expect(result.escalate).toBe(true);
    expect(result.isHallucination).toBe(true);
  });
});

describe('A12 — a voice note is transcribed and answered without a human', () => {
  const voiceUnderstanding: MediaUnderstanding = {
    derivedText:
      'The customer sent a voice message. Transcript:\n<untrusted_voice_transcript>\nhow long does shipping take\n</untrusted_voice_transcript>',
    images: [],
    confidence: 0.9,
    transcripts: [
      { messageId: 'message-2', text: 'how long does shipping take' },
    ],
  };

  it('answers from the transcript through the normal text path', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Shipping takes 3-5 days.',
        cited_chunk_ids: ['c2'],
        confidence: 0.8,
        escalate: false,
      }),
    );
    const { runtime, search, visionCompleteWithTools } = makeHarness({
      completeWithTools,
      understanding: voiceUnderstanding,
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [VOICE_MEDIA] }),
    );

    expect(result.escalate).toBe(false);
    expect(result.answer).toBe('Shipping takes 3-5 days.');
    expect(result.citedChunkIds).toEqual(['chunk-2']);
    const [, voiceQuery] = search.mock.calls[0] as [string, string];
    expect(voiceQuery).toContain('how long does shipping take');
    // A voice turn carries no image, so it stays on the normal chat binding.
    expect(visionCompleteWithTools).not.toHaveBeenCalled();
    expect(completeWithTools).toHaveBeenCalledTimes(1);
  });

  it('caps confidence by how well the audio was heard (D10, extended)', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Shipping takes 3-5 days.',
        cited_chunk_ids: ['c2'],
        confidence: 0.95,
        escalate: false,
      }),
    );
    const { runtime } = makeHarness({
      completeWithTools,
      understanding: { ...voiceUnderstanding, confidence: 0.3 },
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [VOICE_MEDIA] }),
    );

    // min(0.95, 0.3) < the tenant's 0.5 threshold: a half-heard note cannot
    // produce a confident answer, and it escalates exactly as a low-confidence
    // text turn does.
    expect(result.confidence).toBeCloseTo(0.3);
    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(result.escalationSource).toBe('agent_decision');
  });
});

describe('F17 exit criterion — malformed media escalates cleanly', () => {
  it('turns unreadable bytes into UNSUPPORTED_MEDIA without calling the LLM', async () => {
    const completeWithTools = jest.fn();
    const { runtime, search } = makeHarness({
      completeWithTools,
      understandError: new MediaUnreadable('corrupt'),
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [IMAGE_MEDIA] }),
    );

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('UNSUPPORTED_MEDIA');
    expect(result.escalationSource).toBe('error_forced');
    expect(result.escalationDetail).toBe('media_unreadable');
    expect(result.confidence).toBe(0);
    // The customer still gets a reply, and nothing downstream ever ran.
    expect(result.answer).toContain('human agent');
    expect(search).not.toHaveBeenCalled();
    expect(completeWithTools).not.toHaveBeenCalled();
  });

  it('turns a failed transcription into UNSUPPORTED_MEDIA, tagged as a transcription failure', async () => {
    const { runtime } = makeHarness({
      completeWithTools: jest.fn(),
      understandError: new TranscriptionFailed('inaudible'),
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [VOICE_MEDIA] }),
    );

    expect(result.escalationReason).toBe('UNSUPPORTED_MEDIA');
    expect(result.escalationDetail).toBe('transcription_failed');
  });

  it('records the media stage as its own span even when it fails', async () => {
    const { runtime } = makeHarness({
      completeWithTools: jest.fn(),
      understandError: new MediaUnreadable('corrupt'),
    });

    const result = await runtime.respond(
      makeInput({ currentMessage: '', media: [IMAGE_MEDIA] }),
    );

    expect(result.telemetry.spans).toHaveProperty('mediaMs');
  });

  it('lets a non-AgentError from the media stage surface rather than swallowing it', async () => {
    const { runtime } = makeHarness({
      completeWithTools: jest.fn(),
      understandError: new TypeError('programmer error'),
    });

    await expect(
      runtime.respond(makeInput({ currentMessage: '', media: [IMAGE_MEDIA] })),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('D3 (2026-09-17, launch-blocking) — the loop deadline excludes the media pre-pass', () => {
  /**
   * A clock the test controls directly, so "the pre-pass took 7s" can be
   * simulated without a real timer — the `understand()` mock below advances
   * `now` itself, exactly like a slow network call would advance a real
   * clock while `await` is suspended.
   */
  function makeControllableClock() {
    let now = 0;
    return {
      clock: { nowMs: () => now } as unknown as Clock,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('does not hit deadline_exceeded when the media pre-pass alone consumes most of the deadline', async () => {
    const { clock, advance } = makeControllableClock();
    const AGENT_LOOP_DEADLINE_MS = 8000;
    // The pre-pass (vision/ASR round trip to the self-hosted host) is slow —
    // 7s of an 8s budget — but nothing about the actual loop is: the single
    // completeWithTools call below resolves instantly. Before the D3 fix,
    // deadlineAtMs was computed BEFORE this stage ran, so the loop's very
    // first deadline check (nowMs() >= deadlineAtMs) would already be true
    // and the turn would escalate LLM_ERROR/deadline_exceeded despite the
    // model never even being called too slowly.
    // eslint-disable-next-line @typescript-eslint/require-await -- mocking an async port; no real await needed, only the synchronous clock advance below.
    const understand = jest.fn().mockImplementation(async () => {
      advance(7000);
      return {
        derivedText:
          'The customer sent an image. Automatic description of what it shows:\n<untrusted_image_description>\nAn Acme X200 blender\n</untrusted_image_description>',
        images: [
          { mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64') },
        ],
        confidence: 0.95,
        transcripts: [],
      } satisfies MediaUnderstanding;
    });

    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'The Acme X200 costs 4500 BDT.',
        cited_chunk_ids: ['c1'],
        confidence: 0.9,
        escalate: false,
      }),
    );
    const search = jest.fn().mockResolvedValue(RETRIEVAL_RESULT);
    const assemble = jest.fn((input: { currentMessage: string }) => ({
      messages: [
        { role: 'system' as const, content: 'system' },
        { role: 'user' as const, content: input.currentMessage },
      ],
      tools: [],
      promptVersion: 'v11',
    }));

    const runtime = new AgentRuntime(
      { assemble },
      { completeWithTools } as unknown as LlmProvider,
      {
        completeWithTools,
        supportsVision: () => true,
      } as unknown as VisionLlmProvider,
      { understand } as unknown as MediaUnderstandingService,
      { search } as unknown as RetrievalSearchService,
      {
        check: jest.fn().mockResolvedValue({ isForbidden: false, topic: null }),
      } as unknown as ForbiddenTopicCheckerService,
      {
        check: jest.fn().mockResolvedValue({
          verdict: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      } as unknown as AnswerGroundingVerifierService,
      {
        getPromptToolSchemas: jest.fn().mockResolvedValue([]),
      } as unknown as TenantToolRegistryService,
      {
        authorize: jest.fn(),
        execute: jest.fn(),
      } as unknown as ToolExecutionService,
      {
        saveMediaTranscripts: jest.fn().mockResolvedValue(undefined),
      } as unknown as ConversationService,
      {
        agentLoopDeadlineMs: AGENT_LOOP_DEADLINE_MS,
        agentGroundingCheckEnabled: false,
      } as unknown as AppConfigService,
      clock,
      { wait: jest.fn().mockResolvedValue(undefined) },
      { warn: jest.fn(), error: jest.fn() } as unknown as AppLoggerService,
    );

    const result = await runtime.respond(
      makeInput({ currentMessage: 'how much is this?', media: [IMAGE_MEDIA] }),
    );

    expect(result.escalate).toBe(false);
    expect(result.escalationReason).not.toBe('LLM_ERROR');
    expect(result.escalationDetail).not.toBe('deadline_exceeded');
    expect(result.answer).toBe('The Acme X200 costs 4500 BDT.');
  });
});

describe('text turns are untouched by F17', () => {
  it('never runs the media stage and never changes the message', async () => {
    const completeWithTools = jest.fn().mockResolvedValue(
      respondResult({
        answer: 'Shipping takes 3-5 days.',
        cited_chunk_ids: ['c2'],
        confidence: 0.8,
        escalate: false,
      }),
    );
    const { runtime, understand, search } = makeHarness({ completeWithTools });

    const result = await runtime.respond(
      makeInput({ currentMessage: 'how long is shipping?' }),
    );

    expect(understand).not.toHaveBeenCalled();
    const [, textQuery] = search.mock.calls[0] as [string, string];
    expect(textQuery).toBe('how long is shipping?');
    expect(result.telemetry.spans).not.toHaveProperty('mediaMs');
    expect(result.escalate).toBe(false);
  });
});
