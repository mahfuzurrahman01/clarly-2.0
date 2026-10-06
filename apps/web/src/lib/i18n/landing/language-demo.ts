import type { Locale } from "../locale";

/**
 * The language scene shows the *same* conversation in both languages side by
 * side, whichever locale the page is in, so this demo is not translated per
 * locale: each entry is written in its own language.
 */
export type LanguageDemoMessage =
  | { kind: "in" | "out"; text: string }
  | { kind: "cite"; text: string }
  | { kind: "book"; text: string };

export type LanguageDemo = {
  label: string;
  initial: string;
  name: string;
  phone: string;
  status: string;
  messages: LanguageDemoMessage[];
  footer: [string, string];
};

export const LANGUAGE_DEMO: Record<Locale, LanguageDemo> = {
  en: {
    label: "English",
    initial: "S",
    name: "Sara A.",
    phone: "+966 55 ••• 4410",
    status: "Answered",
    messages: [
      { kind: "in", text: "Salam, do you have a cleaning slot tonight? How much?" },
      { kind: "out", text: "Wa alaikum assalam! Yes, we're open until 10 pm tonight. A scale & polish is SAR 250 and takes about 45 minutes." },
      { kind: "cite", text: "from · Hours · Price list 2026" },
      { kind: "in", text: "Yes please, send the link." },
      { kind: "book", text: "Book a visit" },
    ],
    footer: ["Answered by Clarly", "2 sources"],
  },
  ar: {
    label: "العربية",
    initial: "س",
    name: "سارة أ.",
    phone: "+966 55 ••• 4410",
    status: "تم الرد",
    messages: [
      { kind: "in", text: "السلام عليكم، عندكم موعد تنظيف الليلة؟ وكم السعر؟" },
      { kind: "out", text: "وعليكم السلام! نعم، نفتح الليلة حتى الساعة 10 مساءً. تنظيف وتلميع الأسنان بـ 250 ريال ويستغرق حوالي 45 دقيقة." },
      { kind: "cite", text: "من · ساعات العمل · قائمة الأسعار 2026" },
      { kind: "in", text: "إيه لو سمحت، أرسل الرابط." },
      { kind: "book", text: "احجز موعدك" },
    ],
    footer: ["تم الرد بواسطة كلارلي", "مصدران"],
  },
};
