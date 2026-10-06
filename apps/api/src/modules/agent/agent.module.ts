import { Module } from '@nestjs/common';
import { CoreModule } from '../core';
import { ConversationModule } from '../conversation/conversation.module';
import { GuardrailModule } from '../guardrail/guardrail.module';
import { LlmModule } from '../llm/llm.module';
import { PromptModule } from '../prompt/prompt.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { ToolExecutionModule } from '../tool-execution/tool-execution.module';
import { ToolRegistryModule } from '../tool-registry/tool-registry.module';
import { AgentRuntime } from './agent-runtime';
import { MediaUnderstandingService } from './media/media-understanding.service';

export * from './escalation-decision';
export * from './agent-turn.dto';
export * from './media/turn-media.dto';
export * from './media/media-whitelist';
export { AgentRuntime } from './agent-runtime';

// Agent (AI-owned): AgentRuntime.respond(turn), bounded loop, escalation decision, agent_runs emission (A4/A5/T1/T9). Enforced rule 1: ToolExecutionModule must not import this module — do not create a reverse dependency.
//
// THIS PASS (A4-proper): `AgentRuntime` ties together every prior Feature 3
// slice (A0/A1/A3/A5/A6) into the bounded loop (D6) — see agent-runtime.ts's
// own doc comment for the full call sequence. `agent_runs` emission (A8) is
// out of Feature 3's scope (a later, separate task in the former feature plan) —
// `respond()` returns its result to the caller, who will eventually persist
// it once A8 exists; this pass doesn't write to any telemetry table.
@Module({
  imports: [
    CoreModule,
    PromptModule,
    LlmModule,
    RetrievalModule,
    GuardrailModule,
    ToolRegistryModule,
    ToolExecutionModule,
    // F17 follow-up: AgentRuntime persists a voice note's ASR transcript
    // through ConversationService once a turn computes it — see the
    // `mediaUnderstanding.transcripts` write below. No cycle: ConversationModule
    // does not import AgentModule.
    ConversationModule,
  ],
  controllers: [],
  providers: [AgentRuntime, MediaUnderstandingService],
  exports: [AgentRuntime],
})
export class AgentModule {}
