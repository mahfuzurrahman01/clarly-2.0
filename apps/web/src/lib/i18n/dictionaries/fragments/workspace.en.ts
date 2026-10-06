/**
 * Clarly 2.0 S1 — `workspace` namespace: Settings → Workspace (the profile
 * Autologic's "business type" became). Same shape rules as ./delivery.en.ts.
 */
export const workspaceEn = {
  eyebrow: "Workspace",
  title: "Workspace profile",
  description:
    "What kind of business this is, where it is, and the currency and language it works in.",
  errorTitle: "We couldn't load your workspace.",
  errorBody: "The workspace profile didn't come back.",
  nameLabel: "Workspace name",
  verticalLabel: "Type of business",
  verticalHint:
    "Sets the defaults and what the console puts first. It never hides a feature you have.",
  verticals: {
    commerce: "Sells products",
    services: "Books appointments",
    hybrid: "Both",
  },
  verticalDescriptions: {
    commerce: "Shops and online stores: catalog, orders, deliveries.",
    services: "Clinics, salons, agencies: services, bookings, calendar.",
    hybrid: "Sells products and books appointments.",
  },
  countryLabel: "Country",
  countryHint: "Two-letter code, for example SA, AE, KW.",
  currencyLabel: "Currency",
  currencyHint: "Three-letter code used for prices and reports, for example SAR.",
  localeLabel: "Default console language",
  localeHint: "The language new team members start in. Each person can still switch.",
  locales: {
    ar: "العربية",
    en: "English",
    bn: "বাংলা (coming soon)",
  },
  notSet: "Not set",
  save: "Save",
  saved: "Workspace profile saved.",
  couldNotSave: "Couldn't save the workspace profile.",
  invalidCountry: "Use a two-letter country code, for example SA.",
  invalidCurrency: "Use a three-letter currency code, for example SAR.",
  adminOnly: "Only an admin can change the workspace profile.",
};
