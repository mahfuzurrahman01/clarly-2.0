// D1: LlmProvider port. Vendor-agnostic 3-method contract — the provider is
// Gemini (not Anthropic), and any future vendor swap is a config change
// (LLM_PROVIDER env var) plus an adapter binding, never a call-site rewrite.
// Automatic multi-provider failover (routing logic) stays deferred per
// TODOS.md. The GeminiProvider adapter, internal streaming, timeout/backoff,
// and the D2 circuit breaker land in the A0-proper pass — this file is the
// contract only.
//
// LlmMessage is a discriminated union (added in A4) so a real multi-turn
// tool-calling loop (AgentRuntime) can round-trip a tool call and its
// result back to the provider — a bare `{role, content}` shape can't
// represent "the assistant called these tools" or "here's tool X's
// result," both of which Gemini's OpenAI-compatible API needs on the
// next turn to keep the conversation coherent.
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; attachments?: LlmImageAttachment[] }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

/**
 * A11 (Feature 17): an image the customer sent, carried alongside the text of
 * the SAME user turn rather than as a separate message or a separate call.
 *
 * Modelled as an additive field on the user message, not as a `content` union,
 * on purpose: every existing call site, prompt layer, and test double keeps
 * passing a plain string, and a provider that cannot see images simply ignores
 * a field it never reads. The alternative (`content: string | Part[]`) would
 * have rippled through countTokens, the prompt layers, and every stub in the
 * suite for no behavioural gain.
 *
 * `dataBase64` is raw base64 (no `data:` prefix) — the adapter builds whatever
 * wire shape its vendor wants.
 */
export interface LlmImageAttachment {
  mimeType: string;
  dataBase64: string;
}

export interface LlmCompleteRequest {
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export type LlmStopReason = 'end_turn' | 'max_tokens' | 'refusal';

export interface LlmCompleteResult {
  content: string;
  stopReason: LlmStopReason;
  usage: LlmUsage;
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON schema, shared with the A2 tool registry contract — same object, not a copy. */
  inputSchema: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Opaque vendor state attached to this tool call, to be echoed back verbatim
   * when the call is replayed in a later message. Consumers (A4's loop) must
   * pass it through untouched and must never read or interpret it — the shape
   * is the provider's, not this port's. Gemini requires it: replaying a tool
   * call without its `thought_signature` is rejected with a 400.
   */
  providerMetadata?: Record<string, unknown>;
}

export interface LlmToolRequest extends LlmCompleteRequest {
  tools: LlmToolDefinition[];
}

export interface LlmToolResult extends LlmCompleteResult {
  toolCalls: LlmToolCall[];
}

export interface LlmCountTokensInput {
  messages: LlmMessage[];
  model?: string;
}

/**
 * D1 port. Abstract class (not a bare interface) so it doubles as its own NestJS
 * DI token — adapters bind via `{ provide: LlmProvider, useClass: GeminiProvider }`
 * in a later pass, and every consumer (AgentModule, etc.) injects this type only.
 */
export abstract class LlmProvider {
  abstract complete(request: LlmCompleteRequest): Promise<LlmCompleteResult>;
  abstract completeWithTools(request: LlmToolRequest): Promise<LlmToolResult>;
  abstract countTokens(input: LlmCountTokensInput): Promise<number>;

  /**
   * A11: whether this binding can actually SEE `LlmImageAttachment`s. Concrete
   * (not abstract) and false by default so existing adapters and test doubles
   * need no change — a provider claims vision only by saying so.
   *
   * A11's caller (AgentRuntime) uses this to decide whether to attach the image
   * bytes to the turn or to run text-only on the vision pre-pass's description.
   * It never silently drops the image either way.
   */
  supportsVision(): boolean {
    return false;
  }
}

/**
 * A11 DI token for the vision-capable binding, distinct from `LlmProvider`
 * because the default chat binding is a self-hosted text-only vLLM model
 * (LLM_PROVIDER=qwen) while vision runs on Gemini's multimodal endpoint.
 *
 * Two tokens rather than one router keeps D1's "one vendor swap point per
 * capability" property: the text path's vendor and the vision path's vendor
 * move independently, and no consumer branches on vendor names.
 */
export abstract class VisionLlmProvider extends LlmProvider {}
