import { toAgentTenantPolicy } from './agent-turn-policy';

describe('toAgentTenantPolicy', () => {
  const agentConfig = {
    persona: 'friendly',
    forbiddenTopics: ['politics'],
    confidenceThreshold: 0.7,
    rerankEnabled: true,
  };
  const tenantPolicy = {
    tonePersonaOverride: 'formal',
    forbiddenTopics: ['medical'],
    confidenceThreshold: 0.5,
    rerankEnabled: false,
  };

  it('prefers the published agent configuration', () => {
    expect(
      toAgentTenantPolicy(
        { config: agentConfig } as Parameters<typeof toAgentTenantPolicy>[0],
        tenantPolicy,
      ),
    ).toEqual({
      tonePersonaOverride: 'friendly',
      forbiddenTopics: ['politics'],
      confidenceThreshold: 0.7,
      rerankEnabled: true,
    });
  });

  it('falls back to the legacy tenant_policy row', () => {
    expect(toAgentTenantPolicy(null, tenantPolicy)).toEqual(tenantPolicy);
  });

  it('is null when neither exists', () => {
    expect(toAgentTenantPolicy(null, null)).toBeNull();
  });
});
