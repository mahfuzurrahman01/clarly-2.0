// A5/A6/D12: a deterministic safety net for the one distress failure the model
// makes in its own words — it recognises the customer is upset, SAYS SO in the
// answer, and then returns `escalate: false`.
//
// WHY code and not prompt (D12: "guardrails are deterministic code, never
// prompt text alone"). Measured 2026-08-16 on the `tone-escalation` corpus at
// temperature 0, 3/3 runs:
//
//   "ei order ta niye ami khub birokto, tomader service kharap"
//     → answer: "I understand you are frustrated with the service. …"
//       escalate: false          ← missed escalation, every run
//
// The gap is lexical, not structural: probed against the same prompt, the
// English near-equivalents ("I am very annoyed about this order, your service
// is bad", "I am really irritated … your service is terrible") and a stronger
// romanized-Bangla phrasing ("ami khub raag korchi …") all escalate correctly.
// Only "birokto" fails to register as anger — while the model still writes the
// acknowledgement. Two L0 wordings were tried (one in the distress paragraph,
// one in the language paragraph); both fixed this case and both destabilised
// two `catering-policies` cases that were green, so neither shipped. An
// embedding-similarity intake check was also measured and rejected: over all
// 161 corpus questions, distress and calm questions interleave between 0.51 and
// 0.63 max-similarity to distress exemplars ("hi" scores above "my father is in
// hospital and the medical device has not arrived"), so no threshold separates
// them.
//
// PRECISION, measured rather than assumed: run over the 483 stored turns of the
// 2026-08-16 3-run eval, this pattern matches exactly two cases — the missed
// escalation above and `tone-escalation#1`, which already escalates. Zero
// matches among the other 159 cases, including every CONTROL case and the very
// common polite boilerplate ("I'm sorry for the inconvenience", "I understand
// your frustration"), which is deliberately NOT matched: only a direct
// second-person assertion about the customer's emotional state counts, because
// that is a statement the model only makes when it has actually classified the
// customer as upset.
//
// It is a NET, not a detector: it cannot catch distress the model never
// verbalises, and it must never be the only distress path (L0's rule stays).
const DISTRESS_ACKNOWLEDGEMENT =
  /\byou (?:are|were|seem|sound|appear)(?: to be)?\s+(?:very |really |quite |so |extremely |understandably |clearly |obviously )*(?:angry|upset|frustrated|distressed|furious|annoyed|irritated|panicking|panicked|desperate)\b/i;

/**
 * True when the agent's own answer states, in the second person, that the
 * customer is angry/upset/frustrated. Pure and side-effect free; the caller
 * decides what to do with it and sets `escalation_reason` once, at its own call
 * site.
 */
export function acknowledgesCustomerDistress(answer: string): boolean {
  return DISTRESS_ACKNOWLEDGEMENT.test(answer);
}
