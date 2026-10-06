/**
 * Arabic orthography varies by keyboard and dialect; fold the variants that
 * carry no meaning for a lexical match (diacritics, tatweel, alef/yeh/waw/yeh
 * hamza forms) so one pattern reads every spelling. Shared by the input-side
 * nets (customer-grievance, safety-risk, late-delivery-complaint) so they all
 * fold the same way.
 */
export function normaliseArabic(text: string): string {
  return text
    .replace(/[ً-ْـ]/g, '') // harakat + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** True when the text contains Arabic script, which selects the Arabic wording of a deterministic reply. */
export function containsArabicScript(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}
