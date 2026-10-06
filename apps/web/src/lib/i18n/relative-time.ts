import type { Locale } from "./locale";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Age =
  | { unit: "invalid" }
  | { unit: "now" }
  | { unit: "minute" | "hour" | "day"; value: number };

/** Unparseable timestamps render as a dash rather than a made-up age. */
const NO_AGE = "—";

/** Whole elapsed minutes/hours/days, floored; a time in the future (clock skew) reads as "now". */
function ageOf(iso: string, now: number): Age {
  const elapsed = now - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return { unit: "invalid" };
  if (elapsed < MINUTE_MS) return { unit: "now" };
  if (elapsed < HOUR_MS) return { unit: "minute", value: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { unit: "hour", value: Math.floor(elapsed / HOUR_MS) };
  return { unit: "day", value: Math.floor(elapsed / DAY_MS) };
}

function nowWord(locale: Locale): string {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
}

/**
 * Age as a phrase that reads on its own or inside a sentence:
 * "46 minutes ago" / "قبل 46 دقيقة", "yesterday" / "أمس", "now" / "الآن".
 */
export function relativeAgo(iso: string, locale: Locale, now: number = Date.now()): string {
  const age = ageOf(iso, now);
  if (age.unit === "invalid") return NO_AGE;
  if (age.unit === "now") return nowWord(locale);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-age.value, age.unit);
}

export type DurationUnit = "minute" | "hour" | "day";

/**
 * Arabic count + noun in the form that follows a preposition (خلال / منذ /
 * قبل), which is how every duration in the console is phrased. ICU's long unit
 * format gives the bare nominative dual ("يومان"), wrong after "خلال".
 */
const ARABIC_DURATION: Record<DurationUnit, Record<Intl.LDMLPluralRule, string>> = {
  minute: {
    zero: "{n} دقيقة",
    one: "دقيقة واحدة",
    two: "دقيقتين",
    few: "{n} دقائق",
    many: "{n} دقيقة",
    other: "{n} دقيقة",
  },
  hour: {
    zero: "{n} ساعة",
    one: "ساعة واحدة",
    two: "ساعتين",
    few: "{n} ساعات",
    many: "{n} ساعة",
    other: "{n} ساعة",
  },
  day: {
    zero: "{n} يوم",
    one: "يوم واحد",
    two: "يومين",
    few: "{n} أيام",
    many: "{n} يومًا",
    other: "{n} يوم",
  },
};

/** A length of time as words, for use inside a sentence: "42 minutes", "خلال يومين". */
export function formatDuration(value: number, unit: DurationUnit, locale: Locale): string {
  if (locale === "ar") {
    const rule = new Intl.PluralRules("ar").select(value);
    return ARABIC_DURATION[unit][rule].replace("{n}", new Intl.NumberFormat("ar").format(value));
  }
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
}

/**
 * Age for a column of timestamps (inbox rows, ticket cards). English uses the
 * narrow unit ("46m", "23h", "1d"). Arabic uses the relative phrase ("قبل 46
 * دقيقة", "أمس"): its narrow units (د / س / ي) are single letters that read
 * as typos, and a bare "ساعة" or "يوم" reads as a label rather than an age.
 */
export function compactAge(iso: string, locale: Locale, now: number = Date.now()): string {
  const age = ageOf(iso, now);
  if (locale === "ar") {
    // ICU spells out "قبل ساعة واحدة"; in a narrow column the plain singular is enough.
    if (age.unit === "minute" && age.value === 1) return "قبل دقيقة";
    if (age.unit === "hour" && age.value === 1) return "قبل ساعة";
    return relativeAgo(iso, locale, now);
  }
  if (age.unit === "invalid") return NO_AGE;
  if (age.unit === "now") return nowWord(locale);
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: age.unit,
    unitDisplay: "narrow",
  }).format(age.value);
}
