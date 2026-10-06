// Deterministic detector for an answer that states a figure: a price, a number
// of days, a fee, a percentage, a phone number, a time (cycle 3b, 2026-10-04).
//
// `no_kb_needed` waives D10's zero-citation override for a turn that states no
// business fact: a greeting, a thank-you, a refusal, and (prompt v14) a
// clarifying question to a message that does not say which product it means.
// That waiver trusts the model's own flag, so it is backed here by the one
// business fact that is cheap to see: a number. A standalone figure in an
// uncited answer is a price, a window, a fee or a contact detail stated without
// evidence, and the waiver does not apply to it — the turn falls back to the
// zero-citation override, exactly as before the waiver existed.
//
// A digit INSIDE a word is not a figure: model names ("SmartPro X1", "Galaxy
// A55", "X200") are what a clarifying question names, and they state nothing.
//
// Measured against every uncited, non-escalated, tool-less turn of the cycle-3b
// eval (12 turns: greetings, thank-yous, refusals): none states a figure.

/** Western, Arabic-Indic, Extended Arabic-Indic and Bengali digits. */
const DIGITS = '0-9\\u0660-\\u0669\\u06F0-\\u06F9\\u09E6-\\u09EF';

/**
 * A run of digits (with thousands/decimal/time separators) not glued to a
 * letter on either side. The lookarounds exclude digits too, so the match can
 * never start or end in the middle of a model name's digit run ("A55").
 */
const FIGURE = new RegExp(
  `(?<![\\p{L}\\p{M}${DIGITS}])[${DIGITS}]+(?:[.,:][${DIGITS}]+)*(?![\\p{L}\\p{M}${DIGITS}])`,
  'u',
);

/** True when the answer contains a standalone number (price, duration, fee, phone, time). */
export function statesFigure(answer: string): boolean {
  return FIGURE.test(answer);
}
