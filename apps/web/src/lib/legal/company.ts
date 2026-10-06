/**
 * The legal entity that operates Clarly. Meta business verification matches
 * the portfolio's legal name, address and website against these exact
 * values, so they must stay identical to the VAT / CR certificate. Change
 * them here only; the legal pages and the marketing footer read from this.
 */
export const COMPANY = {
  legalNameAr: "شركة الطاقات المثمرة للمقاولات شركة شخص واحد",
  legalNameEn: "Empowering Energy",
  commercialRegistration: "1010632197",
  vatNumber: "310559487400003",
  addressAr: "طريق الملك عبدالعزيز، حي المروج، الرياض 12282، المملكة العربية السعودية",
  addressEn: "King Abdulaziz Road, Al Muruj District, Riyadh 12282, Saudi Arabia",
  website: "https://clarly.esap.ai",
  privacyEmail: "privacy@clarly.esap.ai",
  phone: "+966 55 329 1748",
} as const;

/** Bump whenever the text of either legal page changes. ISO date. */
export const LEGAL_LAST_UPDATED = "2026-10-01";
