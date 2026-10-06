// F17 wiring smoke: the two new bindings (A11's VisionLlmProvider, A12's
// Transcriber) must actually resolve out of LlmModule, in both their configured
// and their 'none' form. A DI mistake here is invisible to every unit test —
// they all construct the classes by hand — and shows up as a boot failure.
import { Test } from '@nestjs/testing';
import { AppConfigService, Clock } from '../core';
import { CoreModule } from '../core';
import { LlmModule } from './llm.module';
import { VisionLlmProvider } from './ports/llm-provider.port';
import { Transcriber } from './ports/transcriber.port';

function config(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    llmProvider: 'deepseek',
    llmBaseUrl: 'https://api.deepseek.com/v1',
    llmModel: 'deepseek-v4-flash',
    llmRequestTimeoutMs: 1000,
    llmBreakerFailureThreshold: 5,
    llmBreakerResetMs: 30000,
    geminiApiKey: 'key',
    deepseekApiKey: 'a-deepseek-key',
    visionProvider: 'gemini',
    visionBaseUrl: 'https://vision.invalid/v1',
    visionModel: 'gemini-3.5-flash',
    asrProvider: 'gemini',
    asrBaseUrl: 'https://asr.invalid/v1',
    asrModel: 'gemini-3.5-flash',
    mediaUnderstandingMaxBytes: 1024,
    embeddingProvider: 'qwen',
    embeddingModel: 'qwen3-embedding-0.6b',
    embeddingDimensions: 1024,
    embeddingBaseUrl: 'https://embed.invalid/v1',
    embeddingMaxInputTokens: 512,
    ...overrides,
  } as unknown as AppConfigService;
}

async function moduleWith(cfg: AppConfigService) {
  return Test.createTestingModule({ imports: [CoreModule, LlmModule] })
    .overrideProvider(AppConfigService)
    .useValue(cfg)
    .overrideProvider(Clock)
    .useValue({ nowMs: () => 0 })
    .compile();
}

describe('LlmModule — F17 bindings', () => {
  it('resolves a vision-capable provider and a transcriber when configured', async () => {
    const moduleRef = await moduleWith(config());

    expect(moduleRef.get(VisionLlmProvider).supportsVision()).toBe(true);
    expect(moduleRef.get(Transcriber)).toBeDefined();
  });

  it("binds the self-hosted Qwen box for vision when VISION_PROVIDER is 'qwen'", async () => {
    const moduleRef = await moduleWith(
      config({
        llmProvider: 'qwen',
        llmBaseUrl: 'https://llm.invalid/v1',
        llmModel: 'qwen3.6-35b-a3b',
        visionProvider: 'qwen',
      }),
    );

    expect(moduleRef.get(VisionLlmProvider).supportsVision()).toBe(true);
  });

  it("resolves the refusing bindings when either provider is 'none'", async () => {
    const moduleRef = await moduleWith(
      config({ visionProvider: 'none', asrProvider: 'none' }),
    );

    expect(moduleRef.get(VisionLlmProvider).supportsVision()).toBe(false);
    await expect(
      moduleRef.get(Transcriber).transcribe({
        audio: Buffer.from('x'),
        mimeType: 'audio/ogg',
      }),
    ).rejects.toThrow(/not configured/);
  });
});
