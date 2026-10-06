import { en, type Dictionary } from "./dictionaries/en";
import { ar } from "./dictionaries/ar";
import type { Locale } from "./locale";

const DICTIONARIES: Record<Locale, Dictionary> = { en, ar };

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

export type { Dictionary };
