// F10 (docs/decisions/F10-intake-fields.md): what a tenant may ask their
// agent to collect.
//
// The type list is narrow on purpose. L0 refuses to store card numbers,
// CVVs, OTPs and NID/passport numbers, and an intake field must never become
// the route around that — a tenant defining `card_number` would be asking the
// platform to do exactly what it exists to refuse. The blocklist below is the
// second half of that: the refusal itself stays in L0, where no configuration
// can reach it.
export const INTAKE_FIELD_TYPES = [
  'text',
  'number',
  'email',
  'date',
  'choice',
] as const;
export type IntakeFieldType = (typeof INTAKE_FIELD_TYPES)[number];

export const INTAKE_SCOPES = ['conversation', 'customer'] as const;
export type IntakeScope = (typeof INTAKE_SCOPES)[number];

export interface IntakeField {
  key: string;
  label: string;
  type: IntakeFieldType;
  required: boolean;
  choices?: string[];
  scope: IntakeScope;
}

/**
 * Every field is prompt text competing with retrieved knowledge for the same
 * budget, and an agent working through twelve questions is not a support
 * agent — it is a form with a chat interface.
 */
export const MAX_INTAKE_FIELDS = 8;

/**
 * Substrings that must never appear in a field key or label.
 *
 * Matched loosely (substring, case-insensitive) because the point is to catch
 * intent, not to be a clever validator: `cvv`, `card_number`, `customer card
 * no` and `NID number` should all fail. A tenant with a legitimate need for
 * one of these words in a label can rephrase; the failure mode this prevents
 * is a support agent politely asking a customer to type their card number
 * into WhatsApp.
 */
const BLOCKED_TERMS = [
  'card',
  'cvv',
  'cvc',
  'pin',
  'password',
  'passcode',
  'otp',
  'nid',
  'passport',
  'ssn',
  'social security',
  'account number',
  'routing',
  'iban',
  'security code',
];

export function findBlockedTerm(...values: string[]): string | null {
  const haystack = values.join(' ').toLowerCase();
  return BLOCKED_TERMS.find((term) => haystack.includes(term)) ?? null;
}

/** One line per field for the prompt. Kept terse: this is instruction, not documentation. */
export function renderIntakeInstructions(
  fields: IntakeField[] | null | undefined,
): string {
  // Tolerates null: this reads a jsonb column, and a version row written
  // before the column existed is data, not a programming error.
  if (!fields || fields.length === 0) return '';

  const lines = fields.map((field) => {
    const choices =
      field.type === 'choice' && field.choices?.length
        ? ` (one of: ${field.choices.join(', ')})`
        : '';
    const need = field.required ? 'required' : 'optional';
    return `- ${field.key}: ${field.label}${choices} [${need}]`;
  });

  return [
    '## Information to collect',
    'Ask for these naturally, in the flow of the conversation, and only when you do not already have them:',
    ...lines,
    // Required means "ask", not "block" — a support conversation that refuses
    // to proceed until a form is complete is the IVR tree this product
    // replaces.
    'Never withhold an answer to get one of these. If the customer will not give a value, help them anyway and leave it uncollected.',
    'Whenever the customer has given one of these — in this message or an earlier one — report it in the `intake` argument of your `respond` call as {key, value}, using the keys above exactly.',
  ].join('\n');
}
