// Gulf T8 (F23): text helpers for the rules prefilter. Pure and DI-free.
//
// Gulf comments are written in English, Gulf Arabic and Arabizi, often on a
// phone keyboard, so the same word arrives spelled several ways ("بكم",
// "بِكَم", "بكـم"). Keyword rules compare normalized text on both sides so a
// tenant types a keyword once.

/** Arabic harakat (fathatan..sukun, the Quranic marks up to U+065F) and superscript alef. */
const ARABIC_DIACRITICS = /[ً-ٰٟ]/g;
const TATWEEL = /ـ/g;
const ALEF_VARIANTS = /[آأإٱ]/g;
const ALEF_MAKSURA = /ى/g;
const MENTION = /@[\p{L}\p{N}._]+/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function normalizeCommentText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(ALEF_MAKSURA, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first keyword (as configured) whose normalized form appears in the comment, else null. */
export function findKeyword(
  text: string,
  keywords: readonly string[],
): string | null {
  const haystack = normalizeCommentText(text);
  return (
    keywords.find((keyword) => {
      const needle = normalizeCommentText(keyword);
      return needle.length > 0 && haystack.includes(needle);
    }) ?? null
  );
}

/**
 * False for a comment with nothing to answer: empty, emoji or punctuation
 * only, or only @-mentions ("tag a friend" comments). Those never reach the
 * classifier; spending a model call on "🔥" is the cost D11's tiering avoids.
 */
export function hasMeaningfulText(text: string): boolean {
  return LETTER_OR_DIGIT.test(text.replace(MENTION, ''));
}
