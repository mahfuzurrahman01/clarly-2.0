import { Module } from '@nestjs/common';
import { AppConfigService, AppLoggerService, Clock, CoreModule } from '../core';
import { CircuitBreakerLlmProvider } from './circuit-breaker-llm-provider';
import { DeepSeekLlmProvider } from './deepseek-llm.provider';
import { DeepSeekVisionProvider } from './deepseek-vision.provider';
import { GeminiProvider } from './gemini.provider';
import { GeminiVisionProvider } from './gemini-vision.provider';
import { DisabledVisionProvider } from './disabled-vision.provider';
import { GeminiTranscriber } from './gemini-transcriber.adapter';
import { HuggingFaceTranscriber } from './huggingface-transcriber.adapter';
import { OpenAiCompatibleTranscriber } from './openai-compatible-transcriber.adapter';
import { DisabledTranscriber } from './disabled-transcriber.adapter';
import { QwenLlmProvider, QwenVisionProvider } from './qwen-llm.provider';
import { CachingEmbedder } from './caching-embedder.adapter';
import { GeminiEmbedder } from './gemini-embedder.adapter';
import { QwenEmbedder } from './qwen-embedder.adapter';
import { Embedder } from './ports/embedder.port';
import { LlmProvider, VisionLlmProvider } from './ports/llm-provider.port';
import { Transcriber } from './ports/transcriber.port';

export * from './ports/llm-provider.port';
export * from './ports/embedder.port';
export * from './ports/transcriber.port';
export { CircuitBreakerLlmProvider } from './circuit-breaker-llm-provider';

// Agent (AI-owned): LlmProvider port, chat adapters, breaker, token accounting (A0/T1). Enforced rule 2: must not import RetrievalModule — no implicit RAG-inside-the-provider.
//
// `LlmProvider` binds to `CircuitBreakerLlmProvider`, which wraps whichever
// adapter `LLM_PROVIDER` selects — every consumer (AgentModule, etc.) injects
// `LlmProvider` only and gets breaker behavior for free; nothing outside this
// module ever sees a concrete adapter, and nothing bypasses the breaker.
// `LLM_PROVIDER` is the single vendor swap point (D1) — a further vendor is a
// new case in the factory below, never a call-site change.
//
// Default is 'deepseek' (DeepSeek API, authenticated with DEEPSEEK_API_KEY).
// 'qwen' (self-hosted vLLM) and 'gemini' remain selectable as rollback paths.
@Module({
  imports: [CoreModule],
  controllers: [],
  providers: [
    DeepSeekLlmProvider,
    GeminiProvider,
    QwenLlmProvider,
    {
      provide: LlmProvider,
      useFactory: (
        deepseek: DeepSeekLlmProvider,
        gemini: GeminiProvider,
        qwen: QwenLlmProvider,
        config: AppConfigService,
        clock: Clock,
      ) => {
        let adapter: LlmProvider;
        switch (config.llmProvider) {
          case 'deepseek':
            adapter = deepseek;
            break;
          case 'gemini':
            adapter = gemini;
            break;
          default:
            adapter = qwen;
        }
        return new CircuitBreakerLlmProvider(adapter, config, clock);
      },
      inject: [
        DeepSeekLlmProvider,
        GeminiProvider,
        QwenLlmProvider,
        AppConfigService,
        Clock,
      ],
    },
    // A11 (Feature 17): the vision-capable binding, selected by
    // VISION_PROVIDER and wrapped in the SAME D2 circuit breaker as the text
    // path — a Gemini outage must degrade an image turn to a clean escalation
    // exactly as it degrades a text turn, not hang the loop. Separate breaker
    // instance from the chat one on purpose: the two run on different
    // endpoints, and one vendor's outage must not open the other's breaker.
    GeminiVisionProvider,
    DeepSeekVisionProvider,
    QwenVisionProvider,
    DisabledVisionProvider,
    {
      provide: VisionLlmProvider,
      useFactory: (
        gemini: GeminiVisionProvider,
        deepseek: DeepSeekVisionProvider,
        qwen: QwenVisionProvider,
        disabled: DisabledVisionProvider,
        config: AppConfigService,
        clock: Clock,
      ) => {
        let adapter: import('./ports/llm-provider.port').LlmProvider;
        switch (config.visionProvider) {
          case 'deepseek':
            adapter = deepseek;
            break;
          case 'gemini':
            adapter = gemini;
            break;
          case 'qwen':
            adapter = qwen;
            break;
          default:
            adapter = disabled;
        }
        return new CircuitBreakerLlmProvider(adapter, config, clock);
      },
      inject: [
        GeminiVisionProvider,
        DeepSeekVisionProvider,
        QwenVisionProvider,
        DisabledVisionProvider,
        AppConfigService,
        Clock,
      ],
    },
    // A12: the ASR binding. ASR_PROVIDER is its own swap point for the same
    // reason VISION_PROVIDER is — transcription runs on a different model from
    // the chat path and must be switchable without touching it.
    GeminiTranscriber,
    HuggingFaceTranscriber,
    OpenAiCompatibleTranscriber,
    DisabledTranscriber,
    {
      provide: Transcriber,
      useFactory: (
        config: AppConfigService,
        gemini: GeminiTranscriber,
        huggingface: HuggingFaceTranscriber,
        openaiCompatible: OpenAiCompatibleTranscriber,
        disabled: DisabledTranscriber,
      ) => {
        switch (config.asrProvider) {
          case 'huggingface':
            return huggingface;
          case 'openai-compatible':
            return openaiCompatible;
          case 'none':
            return disabled;
          default:
            return gemini;
        }
      },
      inject: [
        AppConfigService,
        GeminiTranscriber,
        HuggingFaceTranscriber,
        OpenAiCompatibleTranscriber,
        DisabledTranscriber,
      ],
    },
    // Embedder port (A0/D5). EMBEDDING_PROVIDER is the swap point, exactly
    // as LLM_PROVIDER is for the chat provider — consumers inject the
    // `Embedder` port and never learn which vendor backs it.
    //
    // Default is 'qwen' (self-hosted vLLM) rather than Gemini specifically to
    // decouple quotas: the Gemini embedder shares GEMINI_API_KEY with the
    // chat provider, so a KB ingest burst and live chat traffic contend for
    // one rate limit and a 429 fails the turn. The vLLM box has no such cap.
    // 'gemini' remains selectable as the rollback path — both adapters emit
    // 2560-dim vectors, so switching back is a config flip plus a re-embed
    // (scripts/reembed-chunks.ts), never another migration.
    GeminiEmbedder,
    QwenEmbedder,
    //
    // Phase 5 item 6 / TODOS B2: the chosen adapter is wrapped in
    // CachingEmbedder, which removes the remote round trip for a repeated
    // query — 80-92% of retrieval p95 on the F27 corpora. Wrapping at the DI
    // boundary rather than inside each adapter keeps the cache one object with
    // one policy, and keeps both adapters pure transports.
    {
      provide: Embedder,
      useFactory: (
        config: AppConfigService,
        gemini: GeminiEmbedder,
        qwen: QwenEmbedder,
        clock: Clock,
        logger: AppLoggerService,
      ) =>
        new CachingEmbedder(
          config.embeddingProvider === 'gemini' ? gemini : qwen,
          clock,
          logger,
        ),
      inject: [
        AppConfigService,
        GeminiEmbedder,
        QwenEmbedder,
        Clock,
        AppLoggerService,
      ],
    },
    // Alias provider: same singleton instance as the LlmProvider token,
    // exposed under its concrete class so observability consumers (T18
    // platform-health alerting) can call the breaker-specific
    // `getState()` getter without the abstract LlmProvider port needing
    // to know about breaker internals.
    { provide: CircuitBreakerLlmProvider, useExisting: LlmProvider },
  ],
  exports: [
    LlmProvider,
    VisionLlmProvider,
    Transcriber,
    Embedder,
    CircuitBreakerLlmProvider,
  ],
})
export class LlmModule {}
