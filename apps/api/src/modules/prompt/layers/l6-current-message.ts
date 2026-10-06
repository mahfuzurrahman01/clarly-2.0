// D11 L6 — the current inbound message, delimited the same way as L4:
// data, never instructions, per L0's rule.
//
// The leading label is outside the tags on purpose. Prior assistant turns
// are ordinary chat messages in the assembled prompt, and a run of greeting
// turns was observed pulling the model into answering with another greeting
// instead of the question just asked (real WhatsApp traffic, 2026-08-15).
// Naming this message as the one to answer, immediately before it, is the
// cheapest counterweight; the instruction itself lives in L0.
export function renderL6CurrentMessage(currentMessage: string): string {
  return `The customer's new message, which you must answer now:\n<untrusted_user_message>\n${currentMessage}\n</untrusted_user_message>`;
}
