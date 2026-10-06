// DeepSeek LLM adapter. Talks OpenAI-compatible /v1/chat/completions surface.
// Selected via LLM_PROVIDER=deepseek (see llm.module.ts's factory).
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { OpenAiCompatibleLlmProvider } from './openai-compatible-llm.provider';

/**
 * Reasoning OFF on every call, same decision as QwenLlmProvider. deepseek-v4-flash
 * thinks by default, and its reasoning tokens count against `max_tokens`: probed
 * 2026-09-28, the comment classifier's 8-token budget came back empty
 * (`finish_reason: length`, 8/8 reasoning tokens); with thinking disabled the
 * same call returned the correct label. Support turns don't need deliberation.
 */
export const DEEPSEEK_REASONING_OFF = { thinking: { type: 'disabled' } };

@Injectable()
export class DeepSeekLlmProvider extends OpenAiCompatibleLlmProvider {
  constructor(config: AppConfigService) {
    super({
      vendorLabel: 'DeepSeek',
      apiKey: config.deepseekApiKey,
      baseUrl: config.deepseekBaseUrl,
      model: config.deepseekModel,
      timeoutMs: config.llmRequestTimeoutMs,
      extraBody: DEEPSEEK_REASONING_OFF,
    });
  }
}
