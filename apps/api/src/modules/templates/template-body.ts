// Product shell (TemplatesModule, F12): parsing and filling `{{n}}`
// placeholders.
//
// A pure module on purpose, for the same reason customer-service-window.ts is
// one: three callers have to agree on what a template's variables are — the
// controller validating what a tenant authored, the console rendering a
// preview, and the send path filling one in — and each asks at a different
// moment.
//
// Meta's positional `{{1}}` form rather than named `{{name}}`, because for a
// WhatsApp template the wire format IS positional: components carry an
// ordered `parameters` array with no keys. Storing names and mapping them to
// positions at send time would put a silent off-by-one between what a tenant
// wrote and what a customer reads.

/** Matches `{{1}}`, tolerating the inner whitespace Meta's own editor allows. */
const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

export class TemplateBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateBodyError';
  }
}

/**
 * The distinct placeholder positions in a body, ascending.
 *
 * Deduplicated: `{{1}}` used twice is one variable filled in two places, which
 * is both what Meta does and what a person authoring "Hi {{1}}, your order
 * {{2}} is on its way, {{1}}" means.
 */
export function templatePositions(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    found.add(Number(match[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * Rejects a body whose placeholders are not exactly `{{1}}..{{n}}`.
 *
 * Meta rejects these too, but at send time, per message, with an opaque error
 * — so catching it when the tenant saves is the difference between a typo and
 * a template that looks fine until the first customer needs it.
 */
export function assertWellFormedTemplateBody(body: string): void {
  const positions = templatePositions(body);

  if (positions.some((position) => position < 1)) {
    throw new TemplateBodyError(
      'Placeholders are numbered from {{1}}; {{0}} is not a valid position.',
    );
  }

  positions.forEach((position, index) => {
    if (position !== index + 1) {
      throw new TemplateBodyError(
        `Placeholders must run consecutively from {{1}}. This body jumps to {{${position}}} with no {{${index + 1}}}.`,
      );
    }
  });
}

/**
 * Fills a body with positional values.
 *
 * Throws on a count mismatch rather than substituting a blank: a template sent
 * with "your order  is on its way" reads as a bug to the customer and is
 * invisible to the person who sent it.
 */
export function renderTemplateBody(body: string, values: string[]): string {
  const positions = templatePositions(body);

  if (values.length !== positions.length) {
    throw new TemplateBodyError(
      `This template takes ${positions.length} value(s); ${values.length} were supplied.`,
    );
  }

  return body.replace(PLACEHOLDER, (_match, digits: string) => {
    // Safe by construction: assertWellFormedTemplateBody() has run at save
    // time, so position n maps to values[n - 1].
    const value = values[Number(digits) - 1];
    return value ?? '';
  });
}
