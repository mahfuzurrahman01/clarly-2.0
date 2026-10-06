import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AnswerGroundingVerifierService } from './answer-grounding-verifier.service';
import { ForbiddenTopicCheckerService } from './forbidden-topic-checker.service';

export * from './respond-payload.schema';
export * from './citation-verification';
export * from './pii-redaction';
export * from './cosine-similarity';
export * from './answer-grounding';
export { ForbiddenTopicCheckerService } from './forbidden-topic-checker.service';
export { AnswerGroundingVerifierService } from './answer-grounding-verifier.service';

// Agent (AI-owned): forbidden-topic detector, output/citation validation, PII redaction (A6/T2). No dependency-rule constraints apply directly.
//
// THIS PASS (A6-proper): parseRespondPayload() (D11's one-code-path schema
// validation of the terminal `respond` tool call), verifyCitations() (D10's
// fabrication/zero-citation detection, consumed by A5), redactPii()
// (log-only, never applied to the customer-facing reply), and
// ForbiddenTopicCheckerService (D12's embedding-similarity intake check,
// which depends on LlmModule's Embedder).
//
// 2026-08-17: AnswerGroundingVerifierService joins it as the second
// DI-needing guard — an output-side check that the cited passages actually
// cover the question asked, which needs LlmModule's LlmProvider. See
// answer-grounding.ts for the two measured failures behind it.
@Module({
  imports: [LlmModule],
  controllers: [],
  providers: [ForbiddenTopicCheckerService, AnswerGroundingVerifierService],
  exports: [ForbiddenTopicCheckerService, AnswerGroundingVerifierService],
})
export class GuardrailModule {}
