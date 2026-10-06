// A0/D1: the shared body of every OpenAI-compatible LlmProvider adapter.
//
// Both bound vendors speak the same wire protocol — Gemini via its
// `/v1beta/openai` compatibility surface, and the self-hosted vLLM box
// natively — so the port mapping (messages in, tool calls out, errors onto
// T1's exception classes) is identical and lives here exactly once. A
// concrete adapter supplies only what actually differs: credentials, base
// URL, model, and any vendor-specific extra request body.
//
// This class's only job is mapping the raw provider response/errors onto
// the LlmProvider port and T1's exception classes (LLMTimeout,
// LLMEmptyResponse, LLMMalformedToolCall) — it does NOT implement retry
// semantics beyond the request-level timeout; that's A4's job inside the
// bounded loop, using RESCUE_POLICY. See docs/decisions/F3-agent-core.md
// for the D1 asymmetry note this is designed around (a non-Anthropic
// vendor's refusal signaling isn't as battle-tested — `content_filter` maps
// to `stopReason: 'refusal'` as a returned value, never thrown, so A4
// decides what "refusal" means for the loop, not this adapter).
//
// Never echo a provider response body into a thrown error: vendor error
// shapes can carry the API key that produced them.
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  AiHostAuthFailed,
  LLMEmptyResponse,
  LLMMalformedToolCall,
  LLMTimeout,
} from '@repo/errors';
import {
  LlmProvider,
  type LlmCompleteRequest,
  type LlmCompleteResult,
  type LlmCountTokensInput,
  type LlmStopReason,
  type LlmToolCall,
  type LlmToolRequest,
  type LlmToolResult,
} from './ports/llm-provider.port';

/** OpenAI SDK's message-overhead approximation (~4 tokens of framing per message) — see countTokens()'s doc comment for why this is an approximation, not an exact vendor tokenizer count. */
const APPROX_TOKENS_PER_MESSAGE = 4;
const APPROX_CHARS_PER_TOKEN = 4;

export interface OpenAiCompatibleProviderOptions {
  /** Vendor name used only in error messages, so a failing adapter is identifiable in logs. */
  vendorLabel: string;
  /** Some hosts (self-hosted vLLM) are unauthenticated; the SDK still requires a non-empty value. */
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * Vendor-specific fields merged into every chat-completions request body.
   * Not part of the SDK's typed params — the SDK forwards unknown fields to
   * the API as-is.
   */
  extraBody?: Record<string, unknown>;
  /**
   * A11: whether the bound model can see `LlmImageAttachment`s. Declared per
   * adapter (a capability of the model, not of the wire protocol — the vLLM box
   * and Gemini speak the same protocol and differ only here).
   */
  vision?: boolean;
  /**
   * D9: Cloudflare Access service-token headers (CF-Access-Client-Id /
   * CF-Access-Client-Secret), sent on every request when set. Only the
   * self-hosted adapter (QwenLlmProvider) passes these — Gemini's public
   * endpoint has no Access application in front of it and would just ignore
   * them, so this is opt-in per adapter rather than always-on here.
   */
  cfAccessHeaders?: { clientId?: string; clientSecret?: string };
}

export abstract class OpenAiCompatibleLlmProvider extends LlmProvider {
  private readonly client: OpenAI;
  private readonly vendorLabel: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly extraBody: Record<string, unknown>;
  private readonly vision: boolean;

  protected constructor(options: OpenAiCompatibleProviderOptions) {
    super();
    const cfHeaders = options.cfAccessHeaders;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl,
      // D9: CF-Access-Client-Id/Secret are Cloudflare's own header names for
      // a service-token-authenticated Access application — sent on every
      // request when configured, undefined (i.e. omitted) otherwise.
      ...(cfHeaders?.clientId && cfHeaders.clientSecret
        ? {
            defaultHeaders: {
              'CF-Access-Client-Id': cfHeaders.clientId,
              'CF-Access-Client-Secret': cfHeaders.clientSecret,
            },
          }
        : {}),
    });
    this.vendorLabel = options.vendorLabel;
    this.defaultModel = options.model;
    this.timeoutMs = options.timeoutMs;
    this.extraBody = options.extraBody ?? {};
    this.vision = options.vision ?? false;
  }

  override supportsVision(): boolean {
    return this.vision;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const response = await this.callProvider({
      model: request.model ?? this.defaultModel,
      messages: toProviderMessages(request.messages),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    });

    return this.toCompleteResult(response);
  }

  async completeWithTools(request: LlmToolRequest): Promise<LlmToolResult> {
    const response = await this.callProvider({
      model: request.model ?? this.defaultModel,
      messages: toProviderMessages(request.messages),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      tools: toProviderTools(request.tools),
    });

    const base = this.toCompleteResult(response, {
      allowEmptyWithToolCalls: true,
    });
    const rawToolCalls = response.choices[0]?.message.tool_calls ?? [];

    return {
      ...base,
      toolCalls: rawToolCalls.map((raw) => this.toLlmToolCall(raw)),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- approximation is synchronous; async to satisfy the port contract (a real tokenizer call would be).
  async countTokens(input: LlmCountTokensInput): Promise<number> {
    // No public tokenizer endpoint on either vendor's OpenAI-compatible
    // surface — this is a documented approximation (~4 chars/token +
    // per-message framing overhead, the same heuristic widely used for
    // GPT-family models), not a network call. Good enough for D7's budget
    // accounting; swap for a real tokenizer here (not at call sites) if
    // precision ever matters. Real per-call usage still comes from the
    // response's own `usage` block, not from this.
    return input.messages.reduce(
      (total, message) =>
        total +
        APPROX_TOKENS_PER_MESSAGE +
        Math.ceil(message.content.length / APPROX_CHARS_PER_TOKEN),
      0,
    );
  }

  private async callProvider(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(
        { ...params, ...this.extraBody },
        { timeout: this.timeoutMs },
      );
    } catch (error) {
      throw this.mapProviderError(error);
    }
  }

  private mapProviderError(error: unknown): Error {
    if (error instanceof OpenAI.APIConnectionTimeoutError) {
      return new LLMTimeout(
        `${this.vendorLabel} request exceeded ${this.timeoutMs}ms`,
      );
    }
    // D9: a 401/403 in front of the self-hosted host is the Cloudflare
    // Access edge rejecting the service token, not the model rejecting the
    // request — distinct from every other APIError branch below so it never
    // gets folded into a generic "provider error" log line an on-call
    // engineer would chase as a model problem. Checked before the >=500
    // branch since 401/403 is < 500 and would otherwise fall through to the
    // untyped catch-all at the bottom, which does NOT count toward D2's
    // breaker.
    if (
      error instanceof OpenAI.APIError &&
      (error.status === 401 || error.status === 403)
    ) {
      return new AiHostAuthFailed(
        `${this.vendorLabel} rejected the request as unauthenticated (HTTP ${error.status}) — check CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET against the Cloudflare Access application fronting this host`,
      );
    }
    if (
      error instanceof OpenAI.APIError &&
      (error.status === undefined || error.status >= 500)
    ) {
      // Undefined status covers connection-level failures (DNS, refused,
      // etc.) that the SDK also surfaces as APIError — D2 treats those the
      // same as a 5xx for breaker purposes.
      return new LLMTimeout(
        `${this.vendorLabel} provider error: ${error.message}`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private toCompleteResult(
    response: OpenAI.Chat.Completions.ChatCompletion,
    options: { allowEmptyWithToolCalls?: boolean } = {},
  ): LlmCompleteResult {
    const choice = response.choices[0];
    if (!choice) {
      throw new LLMEmptyResponse(`${this.vendorLabel} returned no choices`);
    }

    const content = choice.message.content ?? '';
    const hasToolCalls = (choice.message.tool_calls?.length ?? 0) > 0;
    if (
      !content &&
      !(options.allowEmptyWithToolCalls && hasToolCalls) &&
      choice.finish_reason !== 'content_filter'
    ) {
      throw new LLMEmptyResponse(
        `${this.vendorLabel} returned an empty response`,
      );
    }

    return {
      content,
      stopReason: toStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  private toLlmToolCall(
    raw: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
  ): LlmToolCall {
    if (raw.type !== 'function') {
      throw new LLMMalformedToolCall(
        `${this.vendorLabel} returned an unsupported tool call type: ${raw.type}`,
      );
    }
    // `extra_content` is Gemini's addition to the OpenAI tool-call shape (it
    // carries `google.thought_signature`) and is absent from the SDK's types.
    // Captured opaquely — never read — so toProviderMessages() can replay it.
    // Vendors that don't emit it (vLLM) simply produce no providerMetadata.
    const { extra_content: extraContent } = raw as typeof raw & {
      extra_content?: Record<string, unknown>;
    };
    try {
      return {
        id: raw.id,
        name: raw.function.name,
        input: JSON.parse(raw.function.arguments) as Record<string, unknown>,
        ...(extraContent
          ? { providerMetadata: { extra_content: extraContent } }
          : {}),
      };
    } catch {
      throw new LLMMalformedToolCall(
        `${this.vendorLabel} tool call "${raw.function.name}" had non-JSON arguments: ${raw.function.arguments}`,
      );
    }
  }
}

function toProviderMessages(
  messages: LlmCompleteRequest['messages'],
): ChatCompletionMessageParam[] {
  return messages.map((message): ChatCompletionMessageParam => {
    switch (message.role) {
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content,
        };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.input),
                  },
                  // Gemini rejects a replayed tool call whose original
                  // `extra_content.google.thought_signature` is missing
                  // (HTTP 400 INVALID_ARGUMENT), so the vendor state captured
                  // in toLlmToolCall() goes back out verbatim. Not part of the
                  // OpenAI SDK's typed params — the SDK forwards unknown
                  // fields to the API as-is.
                  ...(call.providerMetadata ?? {}),
                })),
              }
            : {}),
        };
      case 'user':
        // A11: a user turn carrying images becomes a multipart content array —
        // the text part FIRST, so the question the customer asked is what the
        // model reads before it looks at the picture. Images ride as base64
        // data URLs (the OpenAI-compatible `image_url` shape Gemini's
        // /v1beta/openai surface accepts) rather than as links: the bytes live
        // in our own tenant-scoped storage and are never publicly fetchable.
        if (message.attachments && message.attachments.length > 0) {
          return {
            role: 'user',
            content: [
              { type: 'text' as const, text: message.content },
              ...message.attachments.map((attachment) => ({
                type: 'image_url' as const,
                image_url: {
                  url: `data:${attachment.mimeType};base64,${attachment.dataBase64}`,
                },
              })),
            ],
          };
        }
        return { role: 'user', content: message.content };
      case 'system':
        return { role: message.role, content: message.content };
    }
  });
}

function toProviderTools(tools: LlmToolRequest['tools']): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function toStopReason(finishReason: string | null): LlmStopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}
