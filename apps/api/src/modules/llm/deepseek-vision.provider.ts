// A11/D1 (Feature 17): the vision-capable LlmProvider binding for DeepSeek.
//
// Same OpenAI-compatible adapter body as the chat provider — the only
// differences are the model (a multimodal DeepSeek model) and `vision: true`,
// which is what tells AgentRuntime it may attach image bytes to the turn
// instead of falling back to a text-only description.
//
// It is a SEPARATE binding rather than a swap of LLM_PROVIDER because the
// default chat vendor is deliberately the self-hosted box (quota, see
// llm.module.ts) and Feature 17 must not drag every text turn onto Gemini's
// shared credential to gain image understanding on a small minority of turns.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-llm.provider';
import { DEEPSEEK_REASONING_OFF } from './deepseek-llm.provider';

@Injectable()
export class DeepSeekVisionProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super({
      vendorLabel: 'DeepSeek (vision)',
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      timeoutMs: config.llmRequestTimeoutMs,
      vision: true,
      extraBody: DEEPSEEK_REASONING_OFF,
    });
  }
}
