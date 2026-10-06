// A3: assembles D11's seven layers into the shape LlmProvider expects.
// Deliberately pure/stateless — every input is plain data (see
// prompt-assembly.dto.ts's own comment), no DI dependency on
// RetrievalModule/ConversationModule/ToolRegistryModule/TenantContext.
// Callers (A4's AgentModule, later slice) fetch L2-L5's data from their
// owning modules and pass it in; this service only renders. That split is
// what makes "snapshot tests per layer" (A3's verify step) possible
// without a database or mocked services.
import { Injectable } from '@nestjs/common';
import { L0_PLATFORM_SYSTEM_PROMPT } from './layers/l0-platform-system-prompt';
import { renderL1TenantPersona } from './layers/l1-tenant-persona';
import { renderL2TenantPolicySummary } from './layers/l2-tenant-policy-summary';
import { renderL4RetrievedKb } from './layers/l4-retrieved-kb';
import { renderL6CurrentMessage } from './layers/l6-current-message';
import type {
  AssembledPrompt,
  PromptAssemblyInput,
} from './prompt-assembly.dto';
import { PROMPT_VERSION } from './prompt-version';

@Injectable()
export class PromptAssemblyService {
  assemble(input: PromptAssemblyInput): AssembledPrompt {
    const systemSections = [
      L0_PLATFORM_SYSTEM_PROMPT,
      renderL1TenantPersona(input.tenantPersona),
      renderL2TenantPolicySummary(input.tenantPolicy),
      renderConversationSummary(input.conversationSummary),
      renderL4RetrievedKb(input.retrievedChunks),
    ].filter((section) => section.length > 0);

    const messages: AssembledPrompt['messages'] = [
      { role: 'system', content: systemSections.join('\n\n') },
      ...input.recentMessages.map(renderHistoryMessage),
      { role: 'user', content: renderL6CurrentMessage(input.currentMessage) },
    ];

    return {
      messages,
      tools: input.toolSchemas.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
      promptVersion: PROMPT_VERSION,
    };
  }
}

/**
 * A human teammate's reply crosses the wire as an `assistant` turn (the
 * provider contract has no third role) but is LABELLED as a human's, for two
 * reasons the model must not confuse:
 *   - Attribution. Unlabelled, the agent reads a person's words as its own
 *     prior turn and will defend commitments it never made ("as I said, we
 *     will refund you") without any grounding behind them.
 *   - Deference. A human took over for a reason; the label is what lets the
 *     prompt's own instructions treat that turn as authoritative rather than
 *     as agent output to continue from.
 */
function renderHistoryMessage(message: {
  role: 'user' | 'assistant' | 'human_agent';
  content: string;
}): { role: 'user' | 'assistant'; content: string } {
  if (message.role === 'human_agent') {
    return {
      role: 'assistant',
      content: `[Message sent by a human support agent, not by you]\n${message.content}`,
    };
  }
  return { role: message.role, content: message.content };
}

// D7: "rolling summary + last 10 messages" — the summary isn't a turn, so
// it's folded into the system message (a labeled section) rather than
// injected as a synthetic history message.
function renderConversationSummary(summary: string | null): string {
  if (!summary) return '';
  return `## Conversation summary so far\n${summary}`;
}
