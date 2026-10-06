// A6/D12 (2026-08-17): the pure half of the answer-grounding check — the one
// guardrail in this module that needs a second LLM call, so the prompt and the
// verdict parser live here, side-effect free and unit-testable, and only the
// call itself lives in AnswerGroundingVerifierService.
//
// WHY this exists. Two of the three stable-fail cases in the 5-run eval of
// 2026-08-17 are the same defect: the model answers a question the retrieved
// passages do not actually cover, with confidence 1 and a real (non-fabricated)
// citation, so every existing guard passes it.
//
//   "do I need an appointment for a blood test"
//     → passages cover appointments for CONSULTATIONS only
//     → answer: "Yes, you need an appointment for a blood test." (missed escalation)
//
//   "if my item is defective do I pay return shipping"
//     → two documents disagree; only one carries the defective exception
//     → answer picks one silently (missed escalation)
//
// Neither is reachable by the guards we already have: `verifyCitations` only
// asks whether the cited handles EXIST, and D10's composite confidence only
// asks how strongly the cited chunks were retrieved. Both cases cite a chunk
// that was genuinely retrieved and genuinely related — just not a chunk that
// answers the question asked. That distinction is semantic, so no threshold or
// regex reaches it; the prompt route was tried and is documented as exhausted
// (docs/decisions/A0-production-readiness-plan.md P0.4). What IS deterministic
// is the call site: the check runs on a fixed condition, its verdict maps to a
// fixed escalation, and the model under test never sees the result.
//
// It is a NET, not a detector, exactly like distress-acknowledgement.ts: a
// verdict it cannot parse is treated as "no opinion" and changes nothing.
import type { LlmMessage } from '../llm/ports/llm-provider.port';

export type GroundingVerdict = 'COVERED' | 'NOT_COVERED' | 'CONFLICT';

export interface GroundingCheckInput {
  /** The customer's message this turn — the question the answer has to be grounded FOR. */
  question: string;
  /** The agent's draft answer, before it reaches the customer. */
  answer: string;
  /** The passages the agent cited, in the order it cited them. Retrieved chunks it did not cite travel separately in `otherRetrievedPassages`, so the checker can tell cited support from context. */
  citedPassages: string[];
  /**
   * Cycle-3 eval (2026-09-30): retrieved chunks the agent did NOT cite. They are
   * still knowledge-base text the agent saw this turn, and a multi-chunk answer
   * (a price from one chunk compared against an EMI threshold in another, a rule
   * plus its exception) routinely cites only one of them — judged on the cited
   * chunk alone the second half of the inference read as unsupported and a
   * correct answer was escalated (multi-doc-synthesis#3, refund-policy#2).
   * Shown to the checker AFTER the cited passages and labelled as uncited.
   * Never a substitute for citations: D10's zero-citation override still owns
   * an answer that cites nothing.
   */
  otherRetrievedPassages?: string[];
  /**
   * A3 (full-qwen eval): this turn's tool outputs (track_order status, catalog
   * rows), passed SEPARATELY so the checker can see they are tool results, not
   * KB chunks. Unlabelled, a tracking answer built from a tool result read as
   * NOT_COVERED because no "passage" looked like a policy document.
   */
  toolResultPassages?: string[];
}

/** The line the verdict is read from. The check lines above it may name any of the three verdict words, so only this line counts. */
const VERDICT_LABEL = 'VERDICT:';

/**
 * Deliberately narrow: the checker judges GROUNDING and nothing else. Every
 * clause below earns its place from a measured failure —
 * - the "one service is not a similar service" rule is the blood-test case,
 * - the CONFLICT verdict is the defective-return-shipping case,
 * - the "makes no factual claim" carve-out keeps greetings, thanks, and honest
 *   "we don't have that information" answers from being escalated, which is
 *   what a naive "is every claim supported" checker does to them.
 *
 * Cycle 3b (2026-10-04), measured by replaying the checker on the drafts the
 * eval recorded (turn-diagnostics.ts), 3 calls per variant at temperature 0:
 * - A one-word verdict could not check arithmetic: "EMI is available on the
 *   12,900 BDT headphones" (EMI needs > 15,000) and the correct "no" both came
 *   back COVERED 3/3, as did "150 BDT delivery" for a 47,999 BDT phone with
 *   free delivery above 10,000. With three labelled check lines before the
 *   verdict (ITEM / CONDITIONS / CLAIMS), all five came back right 3/3.
 * - conflicting-docs#3: with the "always paid by the customer" notice shown as
 *   an [uncited passage], the one-sided "defective, so the company pays"
 *   answer was COVERED 3/3; the same text labelled as cited was CONFLICT 3/3.
 *   Uncited passages stay (multi-chunk inference needs them); the one-sided
 *   exception rule now says they count.
 */
const SYSTEM_PROMPT = [
  'You are a strict grounding checker for a customer-support agent. You are given the customer question, the agent draft answer, and the ONLY sources the agent was allowed to use: knowledge-base passages the agent cited, labelled [passage N]; other knowledge-base passages it retrieved but did not cite, labelled [uncited passage N]; and, when present, tool results labelled [tool result N]. Every one of these is a legitimate source for the answer.',
  '',
  'Verdicts:',
  'COVERED — every factual claim in the answer is stated in the sources or follows correctly from them, AND the sources are about the exact thing the customer asked about.',
  'NOT_COVERED — the answer asserts something the sources do not state for the SPECIFIC thing asked, or draws a conclusion the sources contradict. A rule about one service, product, or circumstance is NOT a rule about a different product or service: if the passages cover consultations and the question asks about diagnostic tests, that is NOT_COVERED even when both appear in the same document.',
  'CONFLICT — two or more sources state different rules that both apply to this question, so the answer had to choose one of them.',
  '',
  'Rules:',
  '- Judge grounding only. Tone, helpfulness and style are not your concern.',
  '- Tool results are authoritative sources, treated equally to knowledge-base passages. Order status, tracking, prices, stock and catalog rows in a [tool result N] are facts the answer may state; a claim supported by a tool result is COVERED.',
  '- Order confirmations and tracking replies: an answer that reports what a create_order result says (order reference, items, quantities, total, status, pending approval) or what a track_order result says (courier, status, status time, estimated delivery date, last location) is COVERED. Quoting a tracking status or estimated delivery date without adding a stronger promise is COVERED, whatever the customer hoped to hear. A tool result that returns no rows or says not found makes "I could not find that order/product" COVERED.',
  '- If the answer makes no factual claim about the business, it is COVERED. That includes a refusal ("I can\'t help with that"), a clarifying question, a handoff ("I\'m connecting you to a team member"), a greeting, a thank-you, and a statement that the information is not available.',
  '- An answer that correctly says the sources do not cover something is COVERED, not NOT_COVERED.',
  '- Closed list: when a source is a complete list (all branches, all showrooms, all products, all delivery areas), a correct "not available" or "not listed" answer derived from it ("we have no showroom in Barishal") is COVERED, because the list itself proves the absence. A product catalog or a "Products" section is the complete list of the business\'s products, so a statement about all of them ("all our products come with a 1-year warranty") is COVERED when it holds for each product listed. It is NOT_COVERED only if the list is plainly partial or the answer names a different item than the one asked about.',
  '- Summarising or comparing options that are present in the sources is COVERED. When the customer named no specific product, an answer that lists or compares the products, plans or options found in the sources, or states the value for each of them, is COVERED.',
  '- Paraphrase, translation between languages, and currency and unit formatting do not make a claim unsupported.',
  '- Inference across sources is COVERED only when every premise is stated in the sources AND the conclusion is correct. Sources may be spread over several passages and tool results. Check every comparison and calculation yourself: "12,900 BDT is below the 15,000 BDT EMI minimum, so EMI is not available" is COVERED; "EMI is available on the 12,900 BDT headphones" when EMI needs more than 15,000 BDT is NOT_COVERED.',
  '- Thresholds and conditions: when a source attaches a condition to the value the answer states (free above an amount, available only above a minimum, a limit, an "unless" exception) and the sources contain what decides it (the item\'s price, the order value), the answer must apply it. Find the item\'s price in the sources and compare it yourself. Stating the base value when the condition changes it is NOT_COVERED, and leaving the condition out is not a harmless omission: a 60 SAR delivery charge stated for an 800 SAR item when delivery is free above 200 SAR is NOT_COVERED.',
  '- One-sided exceptions: if one source gives a rule WITH an exception ("paid by the customer unless the item is defective") and another source, cited or uncited, gives the same rule WITHOUT it ("always paid by the customer"), a question about that exception is CONFLICT, even if the answer cites only one of them.',
  '- Mirrored rules: a rule written for one party or one circumstance says nothing about the other ("if WE cancel for any reason other than a natural disaster" says nothing about the customer\'s money in a natural disaster). Carrying it across, or reading an exclusion as its opposite, is NOT_COVERED.',
  '- Do NOT excuse an invented fact. If the answer states a price, date, quantity, policy, duration, colour, size, feature, phone number, address or brand that appears in NO source (no passage and no tool result), it is NOT_COVERED, even when the rest of the answer is supported and even when the invented fact sounds plausible. That includes giving a catalog row a colour, size or option its name and fields do not state (calling a plain "X200 Blender" row "white").',
  '',
  'Output format: write exactly three short lines, then the verdict line, and nothing else. Do not deliberate or reconsider; decide.',
  'ITEM: the product, order or situation the question is about, and its price or value if any source states one (or "none").',
  'CONDITIONS: every threshold, minimum, limit or exception the sources attach to what the answer states, and whether it applies to that item (or "none").',
  'CLAIMS: the answer\'s claims checked against the sources, including each comparison and calculation.',
  `${VERDICT_LABEL} <COVERED or NOT_COVERED or CONFLICT>`,
].join('\n');

/**
 * Top-level keys of a tool result that are instructions to the AGENT, not
 * facts. Shown to the checker they read as a source: track_order's guidance
 * ('"out for delivery" is not "arriving today"') turned a correct "out for
 * delivery, estimated today" reply to "is it arriving today?" into
 * NOT_COVERED 3/3 (commerce-tracking#18, cycle 3b); without the key it was
 * COVERED 3/3. `customerMessage` stays: it is the result's own outcome token.
 */
const AGENT_INSTRUCTION_KEYS = ['guidance'];

/** Truncated per passage rather than over the whole prompt, so one long chunk can never crowd the others out of the checker's view. */
const MAX_PASSAGE_CHARS = 2000;

/** Tool results are dense JSON (a create_order row with its guidance text, several tracking rows), so the fact the answer quotes sits further in than in prose. Cutting it off makes a correct answer read as unsupported. */
const MAX_TOOL_RESULT_CHARS = 4000;

/** Retrieval returns a handful of chunks; capping the uncited ones keeps the checker prompt (and its cost) bounded if that ever grows. */
const MAX_OTHER_RETRIEVED_PASSAGES = 6;

export function buildGroundingMessages(
  input: GroundingCheckInput,
): LlmMessage[] {
  const passages = [
    ...input.citedPassages.map(
      (passage, index) =>
        `[passage ${index + 1}]\n${passage.slice(0, MAX_PASSAGE_CHARS)}`,
    ),
    ...(input.otherRetrievedPassages ?? [])
      .slice(0, MAX_OTHER_RETRIEVED_PASSAGES)
      .map(
        (passage, index) =>
          `[uncited passage ${index + 1}]\n${passage.slice(0, MAX_PASSAGE_CHARS)}`,
      ),
    ...(input.toolResultPassages ?? []).map(
      (result, index) =>
        `[tool result ${index + 1}]\n${toolResultFacts(result).slice(0, MAX_TOOL_RESULT_CHARS)}`,
    ),
  ].join('\n\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `CUSTOMER QUESTION:\n${input.question}`,
        '',
        `AGENT DRAFT ANSWER:\n${input.answer}`,
        '',
        `SOURCES:\n${passages}`,
      ].join('\n'),
    },
  ];
}

/** A tool result as the checker sees it: the same JSON without its agent-facing instruction keys. Anything that is not a JSON object is passed through unchanged. */
export function toolResultFacts(result: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return result;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return result;
  }
  const facts = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) => !AGENT_INSTRUCTION_KEYS.includes(key),
    ),
  );
  return JSON.stringify(facts);
}

/**
 * Returns null for anything that is not an unambiguous single verdict — the
 * caller treats null as "no opinion" and leaves the turn exactly as it was.
 * NOT_COVERED is tested before COVERED because it CONTAINS the substring
 * "COVERED"; matching in the other order would read every NOT_COVERED as a
 * pass, which is the one failure mode this net cannot afford.
 */
export function parseGroundingVerdict(text: string): GroundingVerdict | null {
  // Only the verdict line counts when there is one: the check lines above it
  // routinely name NOT_COVERED or CONFLICT while explaining a COVERED answer.
  const labelAt = text.toUpperCase().lastIndexOf(VERDICT_LABEL);
  const upper = (labelAt === -1 ? text : text.slice(labelAt)).toUpperCase();
  const found: GroundingVerdict[] = [];
  if (/\bNOT[_ -]?COVERED\b/.test(upper)) found.push('NOT_COVERED');
  if (/\bCONFLICT\b/.test(upper)) found.push('CONFLICT');
  if (/\bCOVERED\b/.test(upper.replace(/\bNOT[_ -]?COVERED\b/g, ''))) {
    found.push('COVERED');
  }

  // Two different verdicts in one reply is a hedge ("COVERED, but CONFLICT"),
  // not a decision. No opinion.
  return found.length === 1 ? found[0] : null;
}
