// D11 L2 — tenant policy restated in prose for the model. Explicitly NOT
// the enforcement boundary (D12: guardrails are deterministic code —
// GuardrailModule's embedding-similarity forbidden-topic check at intake —
// not prompt text). This layer is redundancy/defense-in-depth only; if it
// were ever the only thing stopping a forbidden topic, that would be a
// GuardrailModule bug, not a prompt-wording bug.
import type { TenantPolicySummaryInput } from '../prompt-assembly.dto';

export function renderL2TenantPolicySummary(
  policy: TenantPolicySummaryInput,
): string {
  const lines = ['## Policy'];

  if (policy.forbiddenTopics.length > 0) {
    lines.push(
      `Do not discuss the following topics; if asked, politely decline and offer to connect the customer with a human: ${policy.forbiddenTopics.join(', ')}.`,
    );
  }

  lines.push(
    'If you are not confident in an answer, say so plainly rather than guessing, and prefer escalating to a human over speculating.',
  );

  if (policy.intakeInstructions) {
    lines.push(policy.intakeInstructions);
  }

  // Only rendered while the tenant is actually closed. Answering stays
  // unchanged — this exists so the agent stops implying someone is reading
  // right now when nobody is until morning.
  if (policy.outOfHours) {
    const { openingHours, response } = policy.outOfHours;
    lines.push(
      response ??
        'The business is currently closed. Still answer what you can from the retrieved content, but when a human is needed, say clearly that a colleague will reply once the team is back rather than implying someone is available now.',
    );
    if (openingHours) {
      lines.push(`Opening hours: ${openingHours}.`);
    }
  }

  return lines.join('\n');
}
