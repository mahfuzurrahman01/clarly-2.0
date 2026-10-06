// A4: recover a terminal `respond` payload the model wrote as TEXT instead of
// emitting it through the provider's native tool-call channel.
//
// WHY this exists (measured, 2026-08-16, `multi-doc-synthesis` "if I buy the
// Vivobook can I pay cash on delivery", 3/3 runs at temperature 0):
//
//   call 1 → toolCalls: []   content: "The Asus Vivobook 15 costs 82,000 BDT …
//                                      cited_chunk_ids: [\"c1\", \"c2\"]
//                                      confidence: 1.0
//                                      escalate: false"
//   call 2 → toolCalls: []   content: "<respond><answer>…</answer>
//                                      <cited_chunk_ids>[\"c1\",\"c2\"]</cited_chunk_ids>…"
//   call 3 → toolCalls: [respond]  input: { answer: "…" }   ← other 3 fields dropped
//                                  → corrective budget spent → LLM_ERROR
//
// The model had the correct, fully-cited answer on the FIRST call and the turn
// was still lost, because the loop only ever looked at `toolCalls`. Every open
// tool-calling model does this some of the time: the serving host's tool parser
// misses a call the model did emit, and the arguments land in `content`.
// Escalating a correct, complete, citable answer to a human because of a
// transport detail is an orchestration bug, not a model limit.
//
// This is a PARSER, not a relaxation of any guard:
//   * the extracted object is validated by the SAME `parseRespondPayload`
//     (D11: "schema-validated by one code path"), and returns null unless the
//     result is COMPLETE and valid — a partial payload falls through to the
//     existing corrective retry exactly as before;
//   * nothing is defaulted or invented. A missing `confidence` stays missing;
//     it is never assumed to be 1, and `escalate` is never assumed false;
//   * the payload it returns then goes through citation verification, the D10
//     composite confidence and A5's escalation decision unchanged — a fabricated
//     citation or an unsupported answer is caught after this, not before.
import { ESCALATION_REASONS } from '@repo/errors';
import {
  parseRespondPayload,
  type RespondPayload,
} from '../guardrail/respond-payload.schema';

const FIELDS = [
  'answer',
  'cited_chunk_ids',
  'confidence',
  'escalate',
  'escalation_reason',
  'no_kb_needed',
] as const;

type FieldName = (typeof FIELDS)[number];

/** Fields other than `answer` — their presence is what distinguishes "the model wrote a respond payload as text" from "the model wrote a chatty plain-text reply". */
const NON_ANSWER_FIELDS = FIELDS.filter(
  (field): field is Exclude<FieldName, 'answer'> => field !== 'answer',
);

/**
 * Returns a complete, schema-valid respond payload found in the model's text,
 * or null. Null means "no payload here" — the caller's existing corrective-retry
 * path applies unchanged; a caller must never treat null as an error.
 */
export function parseRespondPayloadFromText(
  content: string,
): RespondPayload | null {
  if (!content.trim()) return null;

  for (const candidate of [
    fromToolCallEnvelope(content),
    fromParameterTags(content),
    fromJsonObject(content),
    fromTaggedFields(content),
    fromKeyValueLines(content),
  ]) {
    if (candidate === null) continue;
    const parsed = parseRespondPayload(candidate);
    if (parsed.ok) return parsed.payload;
  }
  return null;
}

/** Qwen/Hermes-style `<tool_call>{"name":"respond","arguments":{…}}</tool_call>` that the serving host's parser failed to lift out of the completion. */
function fromToolCallEnvelope(content: string): unknown {
  const match = /<tool_call>([\s\S]*?)<\/tool_call>/i.exec(content);
  if (!match) return null;

  const envelope = parseJson(match[1]);
  if (!isRecord(envelope) || envelope.name !== 'respond') return null;

  const args =
    typeof envelope.arguments === 'string'
      ? parseJson(envelope.arguments)
      : envelope.arguments;
  return isRecord(args) ? args : null;
}

/**
 * Qwen's XML tool-call format: `<tool_call>respond` (or `<function=respond>`)
 * followed by `<parameter=answer>…</parameter>` blocks. Cycle 3b: a complete,
 * valid payload in this shape was missed by the serving host's parser and the
 * turn ended deadline_exceeded_after_tool (commerce-lookup#13). Only a call
 * named `respond` is read.
 */
function fromParameterTags(content: string): unknown {
  if (!/<(?:tool_call>\s*|function=)respond\b/i.test(content)) return null;
  const raw: Partial<Record<FieldName, string>> = {};
  const parameter = /<parameter=(\w+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
  for (
    let match = parameter.exec(content);
    match !== null;
    match = parameter.exec(content)
  ) {
    const name = match[1].toLowerCase();
    if ((FIELDS as readonly string[]).includes(name)) {
      raw[name as FieldName] = match[2];
    }
  }
  return coerce(raw);
}

/** A bare or fenced JSON object carrying the arguments directly. */
function fromJsonObject(content: string): unknown {
  for (const block of jsonBlocks(content)) {
    const value = parseJson(block);
    if (isRecord(value) && typeof value.answer === 'string') return value;
  }
  return null;
}

/** Pseudo-XML: `<answer>…</answer><cited_chunk_ids>…</cited_chunk_ids>…`, with or without a `<respond>` wrapper. */
function fromTaggedFields(content: string): unknown {
  const raw: Partial<Record<FieldName, string>> = {};
  for (const field of FIELDS) {
    const match = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, 'i').exec(
      content,
    );
    if (match) raw[field] = match[1].trim();
  }
  return coerce(raw);
}

/**
 * The answer as prose, followed by `field: value` lines. The answer is whatever
 * precedes the first field line, so the customer-facing text is never truncated
 * at a colon that happens to appear mid-sentence.
 */
function fromKeyValueLines(content: string): unknown {
  const raw: Partial<Record<FieldName, string>> = {};
  let firstFieldIndex = -1;

  for (const field of NON_ANSWER_FIELDS) {
    const match = new RegExp(
      `^[ \\t]*[-*]?[ \\t]*"?${field}"?[ \\t]*[:=][ \\t]*(.+?)[ \\t]*$`,
      'im',
    ).exec(content);
    if (!match) continue;
    raw[field] = match[1].trim();
    if (firstFieldIndex === -1 || match.index < firstFieldIndex) {
      firstFieldIndex = match.index;
    }
  }
  if (firstFieldIndex === -1) return null;

  const answerMatch =
    /^[ \t]*[-*]?[ \t]*"?answer"?[ \t]*[:=][ \t]*(.+?)[ \t]*$/im.exec(content);
  const answer =
    answerMatch && answerMatch.index < firstFieldIndex
      ? answerMatch[1]
      : content.slice(0, firstFieldIndex);
  raw.answer = stripWrapper(answer);

  return coerce(raw);
}

/**
 * Raw strings to typed fields. A value that cannot be read with certainty is
 * DROPPED rather than guessed — the schema then rejects the payload and the
 * caller falls back to a corrective retry, which is the safe outcome.
 */
function coerce(raw: Partial<Record<FieldName, string>>): unknown {
  if (!raw.answer?.trim()) return null;

  const payload: Record<string, unknown> = { answer: raw.answer.trim() };

  if (raw.cited_chunk_ids !== undefined) {
    const ids = toStringArray(raw.cited_chunk_ids);
    if (ids !== null) payload.cited_chunk_ids = ids;
  }
  if (raw.confidence !== undefined) {
    const value = Number(unquote(raw.confidence));
    if (Number.isFinite(value)) payload.confidence = value;
  }
  if (raw.escalate !== undefined) {
    const value = toBoolean(raw.escalate);
    if (value !== null) payload.escalate = value;
  }
  if (raw.no_kb_needed !== undefined) {
    const value = toBoolean(raw.no_kb_needed);
    if (value !== null) payload.no_kb_needed = value;
  }
  if (raw.escalation_reason !== undefined) {
    const value = unquote(raw.escalation_reason).toUpperCase();
    if ((ESCALATION_REASONS as readonly string[]).includes(value)) {
      payload.escalation_reason = value;
    }
  }
  return payload;
}

/** Fenced blocks first (the model's own delimiters are the strongest signal), then the outermost braces. */
function jsonBlocks(content: string): string[] {
  const blocks: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (
    let match = fenced.exec(content);
    match !== null;
    match = fenced.exec(content)
  ) {
    blocks.push(match[1]);
  }
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end > start) blocks.push(content.slice(start, end + 1));
  return blocks;
}

function toStringArray(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '[]' || trimmed.toLowerCase() === 'none') {
    return [];
  }
  const parsed = parseJson(trimmed);
  if (Array.isArray(parsed)) {
    return parsed.every((item) => typeof item === 'string') ? parsed : null;
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

function toBoolean(raw: string): boolean | null {
  const value = unquote(raw).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function unquote(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`,]+$/g, '');
}

/** Removes a `<respond>`/`<answer>` opener and any markdown fence the prose was wrapped in. */
function stripWrapper(raw: string): string {
  return raw
    .replace(/<\/?(?:respond|answer|tool_call)>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
