// A11/D1 (Feature 17): the vision-capable LlmProvider binding.
//
// Same OpenAI-compatible adapter body as the chat provider — the only
// differences are the model (a multimodal Gemini model rather than the
// self-hosted text-only vLLM one) and `vision: true`, which is what tells
// AgentRuntime it may attach image bytes to the turn instead of falling back to
// a text-only description.
//
// It is a SEPARATE binding rather than a swap of LLM_PROVIDER because the
// default chat vendor is deliberately the self-hosted box (quota, see
// llm.module.ts) and Feature 17 must not drag every text turn onto Gemini's
// shared credential to gain image understanding on a small minority of turns.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-llm.provider';

@Injectable()
export class GeminiVisionProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super({
      vendorLabel: 'Gemini (vision)',
      apiKey: config.geminiApiKey,
      baseUrl: config.visionBaseUrl,
      model: config.visionModel,
      timeoutMs: config.llmRequestTimeoutMs,
      vision: true,
    });
  }
}
