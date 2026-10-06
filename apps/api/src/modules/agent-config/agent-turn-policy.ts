// Product shell (AgentConfigModule, F9): the one mapping from "which
// configuration answers" to the policy slice an agent turn runs with.
//
// A published agent (F9) wins; a tenant whose agents cannot be resolved runs
// from its legacy `tenant_policy` row. Shared by the respond path and the
// comment pipeline (Gulf T8) so both answer a customer under exactly the same
// persona, forbidden topics, threshold and rerank setting.
import type { AgentTenantPolicyInput } from '../agent/agent-turn.dto';
import type { TenantPolicyRecord } from '../onboarding/tenant-policy.dto';
import type { ResolvedAgent } from './agent-config.dto';

export function toAgentTenantPolicy(
  agent: Pick<ResolvedAgent, 'config'> | null,
  tenantPolicy: Pick<
    TenantPolicyRecord,
    | 'tonePersonaOverride'
    | 'forbiddenTopics'
    | 'confidenceThreshold'
    | 'rerankEnabled'
  > | null,
): AgentTenantPolicyInput | null {
  if (agent) {
    return {
      tonePersonaOverride: agent.config.persona,
      forbiddenTopics: agent.config.forbiddenTopics,
      confidenceThreshold: agent.config.confidenceThreshold,
      rerankEnabled: agent.config.rerankEnabled,
    };
  }
  if (tenantPolicy) {
    return {
      tonePersonaOverride: tenantPolicy.tonePersonaOverride,
      forbiddenTopics: tenantPolicy.forbiddenTopics,
      confidenceThreshold: tenantPolicy.confidenceThreshold,
      rerankEnabled: tenantPolicy.rerankEnabled,
    };
  }
  return null;
}
