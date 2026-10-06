import type { Locale } from "@/lib/i18n/locale";
import { privacyAr } from "./privacy.ar";
import { privacyEn } from "./privacy.en";
import { termsAr } from "./terms.ar";
import { termsEn } from "./terms.en";
import type { LegalDocumentContent } from "./types";

export type LegalDocumentKind = "privacy" | "terms";

const DOCUMENTS: Record<LegalDocumentKind, Record<Locale, LegalDocumentContent>> = {
  privacy: { en: privacyEn, ar: privacyAr },
  terms: { en: termsEn, ar: termsAr },
};

export function getLegalDocument(
  kind: LegalDocumentKind,
  locale: Locale,
): LegalDocumentContent {
  return DOCUMENTS[kind][locale];
}

export { COMPANY, LEGAL_LAST_UPDATED } from "./company";
export type { LegalDocumentContent, LegalSection } from "./types";
