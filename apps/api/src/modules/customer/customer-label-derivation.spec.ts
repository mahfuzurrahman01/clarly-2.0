// Feature 18: the A5-signal -> label rule. Pure function, so every branch is
// covered here rather than through a database.
import { deriveAgentLabel } from './customer-label-derivation';

describe('deriveAgentLabel()', () => {
  it('labels a customer who asked for a human as hot', () => {
    expect(
      deriveAgentLabel({
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'agent_decision',
      }),
    ).toBe('hot');
  });

  it('labels a distressed customer as hot — tone, not confidence, is the trigger (L0/D12)', () => {
    expect(
      deriveAgentLabel({
        escalate: true,
        escalationReason: 'CUSTOMER_DISTRESS',
        escalationSource: 'agent_decision',
      }),
    ).toBe('hot');
  });

  it('labels a complaining customer as hot — the highest-intent contact there is (F25/D5)', () => {
    // They have already bought; whether they buy again is being decided right
    // now. F19's segments read this label.
    expect(
      deriveAgentLabel({
        escalate: true,
        escalationReason: 'CUSTOMER_COMPLAINT',
        escalationSource: 'agent_decision',
      }),
    ).toBe('hot');
  });

  it("labels an escalation caused by the agent's own limits as warm, not hot", () => {
    // The conversation needs a person, but the trigger was our knowledge gap,
    // not a customer signal — treating this as the same intent as "get me a
    // human" would make every KB hole look like a hot lead.
    for (const reason of [
      'CONFIDENCE_BELOW_THRESHOLD',
      'KB_NOT_INDEXED',
      'KB_CONFLICT',
      'TOOL_FAILURE',
    ] as const) {
      expect(
        deriveAgentLabel({
          escalate: true,
          escalationReason: reason,
          escalationSource: 'agent_decision',
        }),
      ).toBe('warm');
    }
  });

  it('labels a turn the agent answered end to end as cold', () => {
    expect(
      deriveAgentLabel({
        escalate: false,
        escalationReason: null,
        escalationSource: null,
      }),
    ).toBe('cold');
  });

  it('derives NOTHING from an error_forced escalation, whatever the reason (D13)', () => {
    // The whole point of D13's two sources: our provider breaking, our send
    // failing, or a tenant hitting its spend cap says nothing about the
    // customer. If these relabelled, an outage would read as a wave of leads
    // going warm.
    for (const reason of [
      'LLM_ERROR',
      'DELIVERY_FAILURE',
      'JOB_FAILURE',
      'USAGE_CAP_EXCEEDED',
    ] as const) {
      expect(
        deriveAgentLabel({
          escalate: true,
          escalationReason: reason,
          escalationSource: 'error_forced',
        }),
      ).toBeNull();
    }
  });

  it('still refuses to derive when an error_forced escalation carries a customer-shaped reason', () => {
    // Source wins over reason. A reason that would otherwise mean "hot" must
    // not smuggle a label in through the error path.
    expect(
      deriveAgentLabel({
        escalate: true,
        escalationReason: 'EXPLICIT_USER_REQUEST',
        escalationSource: 'error_forced',
      }),
    ).toBeNull();
  });

  it('falls back to warm for an agent-decided escalation with no reason recorded', () => {
    expect(
      deriveAgentLabel({
        escalate: true,
        escalationReason: null,
        escalationSource: 'agent_decision',
      }),
    ).toBe('warm');
  });
});
