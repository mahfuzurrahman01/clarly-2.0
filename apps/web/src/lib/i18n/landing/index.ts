import type { Locale } from "../locale";
import { ar } from "./ar";
import { en } from "./en";
import type { LandingContent } from "./types";

const CONTENT: Record<Locale, LandingContent> = { en, ar };

export function getLandingContent(locale: Locale): LandingContent {
  return CONTENT[locale];
}

export type { LandingContent } from "./types";
export { LANGUAGE_DEMO } from "./language-demo";
