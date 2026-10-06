import type { Locale } from "@/lib/i18n/locale";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import type {
  AutoEligibilityCriterionKey,
  CriterionEvidence,
  CriterionEvidenceValue,
} from "@/lib/api/orders";
import { formatDuration } from "@/lib/i18n/relative-time";

/**
 * F25 display helpers. Lives beside the components rather than in `lib/`
 * because nothing outside the orders lane needs it.
 *
 * Money arrives as a decimal string and is *formatted*, never arithmetic'd:
 * an unparseable value falls back to the raw string so a merchant sees what
 * is actually stored rather than "NaN".
 */
export function formatMoney(
  amount: string,
  currency: string,
  locale: Locale,
): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    // Unknown currency code on an older row — show it plainly rather than throw.
    return `${value} ${currency}`;
  }
}

/** Absolute date + time, for anything a merchant might have to quote later. */
export function formatDateTime(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/**
 * Whole hours left before the expiry sweep moves a `pending_approval` order
 * to `expired` (D1.4). Negative once the window has passed — the sweep runs
 * on a schedule, so an order can sit a little past its window.
 */
export function hoursUntilExpiry(
  createdAt: string,
  approvalWindowHours: number,
  now: number,
): number {
  const deadline =
    new Date(createdAt).getTime() + approvalWindowHours * 3_600_000;
  return Math.floor((deadline - now) / 3_600_000);
}

const CRITERION_KEYS: readonly AutoEligibilityCriterionKey[] = [
  "human_approval_tenure",
  "decided_orders",
  "rejection_rate",
  "catalog_ready",
  "cod_enabled",
];

function isKnownCriterion(key: string): key is AutoEligibilityCriterionKey {
  return (CRITERION_KEYS as readonly string[]).includes(key);
}

/**
 * Heading for a D1.5 criterion. The API owns the *evidence* (`detail`); this
 * only names the gate, and falls back gracefully if the backend adds a sixth
 * one before the console knows about it.
 */
export function criterionLabel(key: string, t: Dictionary): string {
  return isKnownCriterion(key) ? t.orders.criteria[key] : t.orders.criteria.unknown;
}

type DetailMatcher = {
  pattern: RegExp;
  render: (match: RegExpMatchArray, t: Dictionary) => string;
};

export function modeName(mode: string, t: Dictionary): string {
  if (mode === "human_approval") return t.orders.settings.modeHumanApproval;
  if (mode === "auto") return t.orders.settings.modeAuto;
  if (mode === "disabled") return t.orders.settings.modeDisabled;
  return mode;
}

/**
 * The API's evidence sentences (order-settings.service.ts, evaluateAutoEligibility)
 * are English free text. Until it sends structured evidence, recognise each
 * known sentence and re-render it in the console's language. Anchored
 * patterns, so a reworded sentence falls through to the raw text rather than
 * being half-translated.
 */
const CRITERION_DETAIL_MATCHERS: Record<AutoEligibilityCriterionKey, DetailMatcher[]> = {
  human_approval_tenure: [
    {
      pattern: /^Requires (\d+) days in human-approval mode; ordering has never been enabled\.$/,
      render: (m, t) => fill(t.orders.criteriaDetail.tenureNever, { required: m[1] }),
    },
    {
      pattern:
        /^Requires (\d+) days in human-approval mode; enabled (\d+) day\(s\) ago in mode "([a-z_]+)"\.$/,
      render: (m, t) =>
        fill(t.orders.criteriaDetail.tenure, {
          required: m[1],
          days: m[2],
          mode: modeName(m[3], t),
        }),
    },
  ],
  decided_orders: [
    {
      pattern: /^Requires (\d+) approved-or-rejected orders; (\d+) so far\.$/,
      render: (m, t) =>
        fill(t.orders.criteriaDetail.decidedOrders, { required: m[1], count: m[2] }),
    },
  ],
  rejection_rate: [
    {
      pattern:
        /^Requires a rejection rate below (\d+)%; currently ([\d.]+)% \((\d+) of (\d+)\)\.$/,
      render: (m, t) =>
        fill(t.orders.criteriaDetail.rejectionRate, {
          max: m[1],
          rate: m[2],
          rejected: m[3],
          total: m[4],
        }),
    },
  ],
  catalog_ready: [
    {
      pattern: /^Requires at least one active catalogue product; there are none\.$/,
      render: (_m, t) => t.orders.criteriaDetail.catalogEmpty,
    },
    {
      pattern: /^A store is connected but no active product is linked to it\b/,
      render: (_m, t) => t.orders.criteriaDetail.catalogUnlinked,
    },
    {
      pattern: /^(\d+) active product\(s\), (\d+) linked to a connected store\.$/,
      render: (m, t) =>
        fill(t.orders.criteriaDetail.catalogLinked, { active: m[1], linked: m[2] }),
    },
    {
      pattern: /^(\d+) active product\(s\); no store connected, orders stay in Clarly\.$/,
      render: (m, t) => fill(t.orders.criteriaDetail.catalogNoStore, { active: m[1] }),
    },
  ],
  cod_enabled: [
    {
      pattern: /^Cash on delivery is enabled\.$/,
      render: (_m, t) => t.orders.criteriaDetail.codOn,
    },
    {
      pattern: /^Cash on delivery is the only phase-1 payment method and is currently disabled\.$/,
      render: (_m, t) => t.orders.criteriaDetail.codOff,
    },
  ],
};

/** The criterion's evidence in the console's language, or the API's sentence when it isn't one we know. */
export function criterionDetail(key: string, detail: string, t: Dictionary): string {
  if (!isKnownCriterion(key)) return detail;
  for (const { pattern, render } of CRITERION_DETAIL_MATCHERS[key]) {
    const match = detail.match(pattern);
    if (match) return render(match, t);
  }
  return detail;
}

function asNumber(value: CriterionEvidenceValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asSwitch(value: CriterionEvidenceValue | undefined): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "true" || value === "on" || value === "enabled") return true;
  if (value === 0 || value === "false" || value === "off" || value === "disabled") return false;
  return null;
}

function paramNumber(c: CriterionEvidence, name: string): number | null {
  const value = c.params?.[name];
  return value === undefined ? null : asNumber(value);
}

/** The API sends rates in percent (`unit: "percent"`, 5 = 5%); a ratio is accepted when no unit says otherwise. */
function toRatio(value: number, unit: string | null | undefined): number {
  return unit === "percent" || unit === "%" || (!unit && value > 1) ? value / 100 : value;
}

/** The criterion's evidence rebuilt from its structured fields, or null when they're absent or unfamiliar. */
function structuredDetail(c: CriterionEvidence, t: Dictionary, locale: Locale): string | null {
  const required = asNumber(c.required);
  const actual = asNumber(c.actual);
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  const d = t.orders.criteriaDetail;

  switch (c.code) {
    case "human_approval_days":
      if (required === null || actual === null) return null;
      return fill(d.tenureDays, {
        required: formatDuration(required, "day", locale),
        actual: formatDuration(Math.max(0, Math.floor(actual)), "day", locale),
      });
    case "approved_orders_count":
      if (required === null || actual === null) return null;
      return fill(d.decidedOrders, { required: count(required), count: count(actual) });
    case "rejection_rate": {
      if (required === null || actual === null) return null;
      const rejected = paramNumber(c, "rejected");
      const decided = paramNumber(c, "decided");
      if (c.unit === "percent" && rejected !== null && decided !== null) {
        const oneDecimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
        return fill(d.rejectionRate, {
          max: oneDecimal.format(required),
          rate: oneDecimal.format(actual),
          rejected: count(rejected),
          total: count(decided),
        });
      }
      const percent = (n: number) =>
        new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
          toRatio(n, c.unit),
        );
      return fill(d.rejectionRateShort, { required: percent(required), actual: percent(actual) });
    }
    case "active_products":
      return actual === 0 ? d.catalogEmpty : null;
    case "products_linked": {
      if (actual === null) return null;
      if (actual === 0) return d.catalogUnlinked;
      const active = paramNumber(c, "activeProducts");
      if (active !== null) return fill(d.catalogLinked, { active: count(active), linked: count(actual) });
      return required === null
        ? null
        : fill(d.productsLinked, { required: count(required), actual: count(actual) });
    }
    case "store_connected": {
      if (asSwitch(c.actual) !== false) return null;
      const active = paramNumber(c, "activeProducts");
      return active === null ? d.storeNotConnected : fill(d.catalogNoStore, { active: count(active) });
    }
    case "cod_enabled": {
      const on = asSwitch(c.actual);
      return on === null ? null : on ? d.codOn : d.codOff;
    }
    default:
      return null;
  }
}

/**
 * A criterion's evidence in the console's language. Prefers the API's
 * structured `code` + `required`/`actual`; falls back to recognising the
 * English `detail` sentence, and finally to the sentence as sent.
 */
export function criterionEvidence(
  key: string,
  c: CriterionEvidence & { detail: string },
  t: Dictionary,
  locale: Locale,
): string {
  return structuredDetail(c, t, locale) ?? criterionDetail(key, c.detail, t);
}

/** `{name}` → value substitution, the same template convention the catalog lane uses. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}
