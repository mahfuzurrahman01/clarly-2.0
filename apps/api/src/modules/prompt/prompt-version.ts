// D11: "every assembled prompt carries a prompt_version on agent_runs —
// without it, resolution-rate trends are uninterpretable across prompt
// edits." Bump this on ANY change to a layer's template (L0's wording, L1's
// section header, L2's phrasing, L4/L6's delimiter format, or the assembly
// order itself) — not on data changes (a different tenant persona or KB
// chunk set is not a prompt-version change, since the template is
// unchanged). A8 (later slice) persists this on `agent_runs`; this module
// only stamps it on the assembled output.
// Held at v11. A v12 attempt on 2026-08-17 added three L0 clauses (tiered-date
// interval arithmetic, a sharpened mirror-image clause, and a "do not quote
// costs to a distressed customer" rule). Measured over a 5-run/805-turn
// invocation it fixed 2 catering-policies cases and broke 3 previously-passing
// cases in other corpora, taking missed escalation from 1 to 2. Reverted. The
// remaining defects need deterministic code paths, not more L0 text — see the
// non-goals in docs/decisions/A0-production-readiness-plan.md.
// v12 (F25/D5.2): one L0 clause, the CUSTOMER_COMPLAINT escalation reason, plus
// its mention in the escalation_reason field description. This is the change
// D5 chose over building a second classifier — the complaint signal rides the
// mechanism CUSTOMER_DISTRESS already uses. Per the Phase 5 gate, this bump
// REQUIRES a full eval-suite rerun before merge; it has not been run in the
// implementing session (no LLM credentials there) and is called out in the
// F25 handoff entry as the outstanding merge gate.
// v13 (cycle-3 evals, next-fix #3 and the prompt half of #6): three L0
// paragraphs, all conditional on the tool existing. (1) The reply-language rule
// now names Arabic/Arabizi and forbids a language or script the customer did not
// use (an Arabizi+image message was answered in Bengali; the old text only
// exemplified Bangla). (2) Tool-first routing: price/stock/availability/brand
// questions call lookup_product before answering or escalating (an Arabic
// brand-availability question skipped the lookup and escalated, 3/3 runs).
// (3) create_order rules: lookup first, productIds from those rows, never an
// empty call, the LAST-stated quantity wins ("khalha 2"), and a named variant
// must be ordered as that row, never the plain model. The deterministic halves
// (placeholder/country/phone guards, variant and productId refusals) live in
// code; this text only tells the model what those refusals will demand. Per the
// Phase 5 gate a bump REQUIRES a full eval-suite rerun before merge, and v12 was
// itself never evaluated, so v12->v13 must be measured together against the
// cycle-3 baseline. Given the failed 2026-08-17 v12 attempt (clauses that fixed
// two cases and broke three), watch escalation and false-escalation counts on
// this run, not just the commerce corpora.
// v14 (cycle 3b fixes, 2026-10-04): five L0 changes, each tied to a measured
// failure in the cycle-3b results, plus one respond-field definition.
// (1) Ambiguous "how much is this?" with no product named: answer for each
// candidate with cited values and ask which one; a bare clarifying question
// only when there is nothing to list (khaleeji#0, egyptian#1 0/5 under v13 —
// v13 replied with an uncited question that D10 zeroed). (2) no_kb_needed now
// covers such a clarifying question; the code half (escalation-decision.ts +
// guardrail/states-figure.ts) refuses that waiver to any answer stating a
// figure. (3) track_order routing for status questions, with a no-argument
// call when no reference was given (journey "where is my order?", complaint#8).
// (4) create_order: with a detail missing, ask for it instead of calling
// (journey Fahd: two empty calls, then no_respond_call). (5) Compounding
// "applied before" rules and threshold-dependent charges, worked out before
// respond and shown in a few lines (catering-quotes#0 additive arithmetic and
// 1,400-token self-corrections past the deadline; multi-doc#2 "150 BDT" when
// 47,999 is above the 10,000 free-delivery threshold). (6) lookup answers do
// not describe attributes the row lacks (commerce-lookup#2: "available in
// grey, compact size" for a row with neither, correctly caught by A6 3/3).
// The v13 caution
// applies: a full L1+L2 re-run is the merge gate.
export const PROMPT_VERSION = 'v14';
