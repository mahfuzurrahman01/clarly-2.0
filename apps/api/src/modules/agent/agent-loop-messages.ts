// A4: small message-building helpers, kept separate from agent-runtime.ts
// so the loop's control flow reads without inline object-literal noise.
import type { LlmMessage, LlmToolResult } from '../llm/ports/llm-provider.port';

/** Records the assistant's tool-call turn in history so the provider sees its own prior call on the next round-trip (required for a coherent multi-turn tool-calling conversation). */
export function assistantToolCallMessage(result: LlmToolResult): LlmMessage {
  return {
    role: 'assistant',
    content: result.content,
    toolCalls: result.toolCalls,
  };
}

export function toolResultMessage(
  toolCallId: string,
  content: string,
): LlmMessage {
  return { role: 'tool', toolCallId, content };
}

/** A corrective nudge appended after a malformed/invalid terminal call — consumes the loop's shared corrective-retry budget (MAX_CORRECTIVE_RETRIES), never a blind identical re-request. */
export function correctiveInstructionMessage(instruction: string): LlmMessage {
  return { role: 'user', content: instruction };
}

/**
 * The assistant's tool-call turn PLUS one `tool` message for every call id in
 * it, in call order. OpenAI-compatible providers (DeepSeek, measured
 * 2026-09-29) reject a history in which an assistant `tool_calls` message is
 * not followed by a tool result for each id with HTTP 400, so the pairing is
 * built here, structurally, rather than left to each caller to remember.
 */
export function answeredToolCallMessages(
  result: LlmToolResult,
  resultFor: (call: LlmToolResult['toolCalls'][number]) => string,
): LlmMessage[] {
  return [
    assistantToolCallMessage(result),
    ...result.toolCalls.map((call) =>
      toolResultMessage(call.id, resultFor(call)),
    ),
  ];
}
