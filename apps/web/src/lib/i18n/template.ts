/**
 * Templates filled from API-supplied values (notification `params`, audit
 * `detailParams`). Unlike the dictionary's own `fill`, a template here is
 * all-or-nothing: if any `{placeholder}` has no usable value the caller gets
 * null and shows the API's English sentence instead of a half-filled one.
 */
export type TemplateParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)\}/g;

/** Only a string or a finite number fills a placeholder; the values are API data. */
export function paramValue(params: TemplateParams, name: string): string | number | null {
  if (!Object.hasOwn(params, name)) return null;
  const value: unknown = params[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** First-strong isolate (the text form of `<bdi>`): a name or reference keeps its own direction inside either language's sentence. */
export function isolate(text: string): string {
  return `⁨${text}⁩`;
}

function fillComplete(
  template: string,
  params: TemplateParams,
  format: (name: string, value: string | number) => string,
): string | null {
  const names = Array.from(template.matchAll(PLACEHOLDER), (match) => match[1]);
  if (!names.every((name) => paramValue(params, name) !== null)) return null;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = paramValue(params, name);
    return value === null ? whole : format(name, value);
  });
}

/** Numbers in the reader's locale, text isolated. The default when a value needs no special unit. */
export function formatPlain(value: string | number, locale: string): string {
  return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : isolate(value);
}

/** A template, or one that applies only when its `when` matches the params (e.g. a status or a zero count). */
export type TemplateVariant =
  | string
  | { text: string; when: (params: TemplateParams) => boolean };

/** The first variant that applies and can be filled completely, or null. */
export function fillFirst(
  variants: readonly TemplateVariant[],
  params: TemplateParams,
  format: (name: string, value: string | number) => string,
): string | null {
  for (const variant of variants) {
    if (typeof variant !== "string" && !variant.when(params)) continue;
    const filled = fillComplete(typeof variant === "string" ? variant : variant.text, params, format);
    if (filled !== null) return filled;
  }
  return null;
}
