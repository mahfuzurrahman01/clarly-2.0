// A7/D7: the summarization LLM call's prompt — deliberately takes only the
// PRIOR summary (already compact) plus the messages accumulated since it,
// never the whole transcript. This is what actually keeps a 60-turn
// conversation's summarization cost/latency bounded regardless of total
// conversation length — re-reading the entire history on every
// resummarization would defeat the point of having a rolling summary at
// all.
import type { LlmMessage } from '../llm/ports/llm-provider.port';
import type { RecentMessage } from './conversation.dto';

const SUMMARIZATION_INSTRUCTION = `You maintain a running summary of a customer support conversation, for internal use by a support agent (human or AI) — the customer never sees this.

Given the existing summary (if any) and the new messages below, produce an UPDATED summary that preserves every fact that might matter later: names, order/reference numbers, specific issues raised, commitments made, and their resolution status. Keep it under 200 words. Output ONLY the updated summary text — no preamble, no commentary, no headers.`;

const SPEAKER_LABEL: Record<RecentMessage['role'], string> = {
  user: 'Customer',
  assistant: 'Agent',
  human_agent: 'Human support agent',
};

export function buildSummarizationPrompt(
  priorSummary: string | null,
  newMessages: RecentMessage[],
): LlmMessage[] {
  const summarySection = priorSummary
    ? `Existing summary:\n${priorSummary}`
    : 'Existing summary: (none yet — this is the first summarization for this conversation.)';

  // A human teammate's turn is labelled distinctly from the agent's: a
  // summary that folds the two together loses the single most important fact
  // about the conversation's history — that a person had to step in, and
  // what they committed to on the tenant's behalf.
  const transcriptSection = newMessages
    .map((message) => `${SPEAKER_LABEL[message.role]}: ${message.content}`)
    .join('\n');

  return [
    { role: 'system', content: SUMMARIZATION_INSTRUCTION },
    {
      role: 'user',
      content: `${summarySection}\n\nNew messages:\n${transcriptSection}`,
    },
  ];
}
