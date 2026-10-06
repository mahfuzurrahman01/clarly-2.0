// Deterministic net for "track_order found no shipment, and the agent did not
// hand off" (cycle 3b, 2026-10-04).
//
// track_order's contract (track-order.tool.ts description, and the
// not-found guidance in its result) is: "if the tool returns no shipments, say
// you could not find one and escalate to the team rather than guessing". The
// agent then knows nothing about the customer's parcel, so a person has to.
// commerce-tracking#14 (a customer asking about their brother's AWB) was
// answered with a correct, leak-free refusal and NO escalation in 3 of 3 runs:
// the model followed the first half of the contract and dropped the second.
//
// Only a result that has the track_order shape counts (a `shipments` array),
// and the net fires only when NO track_order call of the turn found anything,
// so a turn that tracked one reference successfully is not escalated because a
// second, mistyped one missed.
import { z } from 'zod';

const ShipmentsResultSchema = z.object({ shipments: z.array(z.unknown()) });

function shipmentCount(evidence: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch {
    return null;
  }
  const result = ShipmentsResultSchema.safeParse(parsed);
  return result.success ? result.data.shipments.length : null;
}

/** True when this turn ran track_order and every such call returned no shipment. */
export function trackOrderFoundNothing(toolEvidence: string[]): boolean {
  const counts = toolEvidence
    .map(shipmentCount)
    .filter((count): count is number => count !== null);
  return counts.length > 0 && counts.every((count) => count === 0);
}
