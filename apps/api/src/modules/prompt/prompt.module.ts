import { Module } from '@nestjs/common';
import { PromptAssemblyService } from './prompt-assembly.service';

export * from './prompt-assembly.dto';
export * from './prompt-version';
export { PromptAssemblyService } from './prompt-assembly.service';
export { sanitizeTenantPersona } from './layers/l1-tenant-persona';

// Agent (AI-owned): layered assembly, versioning, policy compilation (A3). Enforced rule 1: ToolExecutionModule must not import this module — do not create a reverse dependency.
//
// THIS PASS (A3-proper): PromptAssemblyService renders D11's seven layers
// (L0-L6) into an AssembledPrompt. Deliberately no imports of
// RetrievalModule/ConversationModule/ToolRegistryModule/TenantContext —
// see prompt-assembly.service.ts's doc comment for why the module stays
// pure/input-driven. No providers need imports here as a result.
@Module({
  imports: [],
  controllers: [],
  providers: [PromptAssemblyService],
  exports: [PromptAssemblyService],
})
export class PromptModule {}
