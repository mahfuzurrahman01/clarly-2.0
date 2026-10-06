// Product shell (AgentConfigModule, F9 step 2): what the respond path learns
// about WHICH agent is answering.
//
// As of the F9 read flip this carries the published CONFIGURATION too, and
// `agent_versions` is authoritative for the respond path.
//
// `tenant_policy` still exists and is still read by the two tenant-level
// consumers that have no per-turn agent to resolve (the stuck-ticket sweep
// and the kanban board config). It is now a MIRROR, not a second source:
// publishing an agent writes the overlapping fields back to it. See
// docs/decisions/F9-agent-configuration.md.
import type { IntakeField } from './intake-fields';

export interface ResolvedAgent {
  agentId: string;
  /** Console-facing name, carried for log lines a human has to read. Never rendered into a prompt. */
  name: string;
  /** Published `agent_versions.version` — the tenant-side half of run attribution, alongside `promptVersion`. */
  configVersion: number;
  /** How it was found. See AgentConfigService.resolveForPhoneNumber() for why the fallback exists. */
  resolvedBy: 'number' | 'tenant_fallback';
  /** The published configuration this turn must run with. */
  config: ResolvedAgentConfig;
}

/** The slice of a published `agent_versions` row the respond path actually uses. */
export interface ResolvedAgentConfig {
  persona: string | null;
  forbiddenTopics: string[];
  confidenceThreshold: number;
  rerankEnabled: boolean;
  handoverAutoReturnMinutes: number;
  maxToolCallsPerTurn: number;
  /** Documents this agent may answer from. Empty = the tenant's whole knowledge base. */
  kbDocumentIds: string[];
  /** Null/empty means always open. */
  businessHours: Record<string, { open: string; close: string }> | null;
  timezone: string | null;
  outOfHoursResponse: string | null;
  /** F10: what this agent collects from customers. */
  intakeFields: IntakeField[];
}
