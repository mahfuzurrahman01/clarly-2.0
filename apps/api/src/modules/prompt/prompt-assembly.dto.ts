import type { PromptToolSchema } from '../tool-registry/tenant-tool.dto';

/** D11 L4 — already-retrieved chunks (A1's output). PromptModule renders these; it never fetches them itself. */
export interface RetrievedChunk {
  id: string;
  content: string;
}

/** D11 L2 input — the raw policy fields PromptModule restates in prose. Real enforcement is D12 (GuardrailModule), not this layer. */
export interface TenantPolicySummaryInput {
  forbiddenTopics: string[];
  confidenceThreshold: number;
  /**
   * Set only when the tenant is CLOSED right now (F9 business hours).
   *
   * The agent still answers from the knowledge base out of hours — a
   * customer asking a documented question at 3am should get their answer.
   * What changes is the promise it makes about a human: without this it says
   * "I'll connect you with someone" and the customer waits all night for a
   * reply that cannot come until morning.
   */
  /** F10: pre-rendered instruction block naming what to collect. Empty when the agent collects nothing. */
  intakeInstructions?: string;
  outOfHours?: {
    /** Human-readable opening hours, already formatted. */
    openingHours: string | null;
    /** The tenant's own wording, when they set one. */
    response: string | null;
  };
}

/** Everything the seven layers (D11) need, as plain data — PromptModule fetches nothing itself, so it's pure and snapshot-testable without DI/DB. */
export interface PromptAssemblyInput {
  /** L1 — free text, sanitized + length-capped by this module (never trust the caller to have done it). */
  tenantPersona: string | null;
  /** L2 */
  tenantPolicy: TenantPolicySummaryInput;
  /** L3 — already scoped to this tenant's enabled tools (A2's TenantToolRegistryService.getPromptToolSchemas()). */
  toolSchemas: PromptToolSchema[];
  /** L4 */
  retrievedChunks: RetrievedChunk[];
  /** L5 part 1 — async rolling summary (A7); null until one exists (e.g. a conversation's first few turns). */
  conversationSummary: string | null;
  /** L5 part 2 — already capped to the last 10 turns by the caller (ConversationModule/A7); PromptModule doesn't re-cap. */
  recentMessages: Array<{
    role: 'user' | 'assistant' | 'human_agent';
    content: string;
  }>;
  /** L6 — the raw current inbound message, delimited as untrusted by this module. */
  currentMessage: string;
}

export interface AssembledPrompt {
  /** Ready to hand to LlmProvider.complete()/completeWithTools() as-is. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** L3, structured — passed as LlmToolRequest.tools, never embedded as prompt text (D11's tool-calling APIs take schemas out-of-band). */
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Stamped on agent_runs (A8, later slice) — without it, resolution-rate trends are uninterpretable across prompt edits (D11). */
  promptVersion: string;
}
