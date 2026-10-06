import type { workspaceEn } from "./workspace.en";

/** Arabic side of the `workspace` namespace — see ./workspace.en.ts. */
export const workspaceAr: typeof workspaceEn = {
  eyebrow: "مساحة العمل",
  title: "ملف مساحة العمل",
  description: "نوع نشاطك، ومكانه، والعملة واللغة التي يعمل بها.",
  errorTitle: "تعذّر تحميل مساحة العمل.",
  errorBody: "لم يصلنا ملف مساحة العمل.",
  nameLabel: "اسم مساحة العمل",
  verticalLabel: "نوع النشاط",
  verticalHint: "يحدد الإعدادات الافتراضية وما تعرضه لوحة التحكم أولًا. لا يخفي أي ميزة لديك.",
  verticals: {
    commerce: "يبيع منتجات",
    services: "يحجز مواعيد",
    hybrid: "الاثنان معًا",
  },
  verticalDescriptions: {
    commerce: "المتاجر والمتاجر الإلكترونية: المنتجات والطلبات والشحنات.",
    services: "العيادات والصالونات والوكالات: الخدمات والحجوزات والتقويم.",
    hybrid: "يبيع منتجات ويحجز مواعيد.",
  },
  countryLabel: "الدولة",
  countryHint: "رمز من حرفين، مثل SA أو AE أو KW.",
  currencyLabel: "العملة",
  currencyHint: "رمز من ثلاثة أحرف للأسعار والتقارير، مثل SAR.",
  localeLabel: "لغة لوحة التحكم الافتراضية",
  localeHint: "اللغة التي يبدأ بها أعضاء الفريق الجدد، ويمكن لكل شخص تغييرها.",
  locales: {
    ar: "العربية",
    en: "English",
    bn: "বাংলা (قريبًا)",
  },
  notSet: "غير محدد",
  save: "حفظ",
  saved: "تم حفظ ملف مساحة العمل.",
  couldNotSave: "تعذّر حفظ ملف مساحة العمل.",
  invalidCountry: "استخدم رمز دولة من حرفين، مثل SA.",
  invalidCurrency: "استخدم رمز عملة من ثلاثة أحرف، مثل SAR.",
  adminOnly: "يمكن للمسؤول فقط تغيير ملف مساحة العمل.",
};
