import {
  findBlockedTerm,
  renderIntakeInstructions,
  MAX_INTAKE_FIELDS,
  type IntakeField,
} from './intake-fields';

const ORDER: IntakeField = {
  key: 'order_number',
  label: 'Order number',
  type: 'text',
  required: true,
  scope: 'conversation',
};

describe('renderIntakeInstructions()', () => {
  it('renders nothing when the agent collects nothing', () => {
    expect(renderIntakeInstructions([])).toBe('');
    expect(renderIntakeInstructions(null)).toBe('');
  });

  it('names each field by the exact key the model must report back', () => {
    const rendered = renderIntakeInstructions([ORDER]);

    expect(rendered).toContain('order_number: Order number');
    expect(rendered).toContain('[required]');
    expect(rendered).toContain('`intake` argument');
  });

  it('lists the options of a choice field, so the model does not invent one', () => {
    const rendered = renderIntakeInstructions([
      {
        key: 'delivery_area',
        label: 'Delivery area',
        type: 'choice',
        required: false,
        choices: ['inside_dhaka', 'outside_dhaka'],
        scope: 'conversation',
      },
    ]);

    expect(rendered).toContain('one of: inside_dhaka, outside_dhaka');
    expect(rendered).toContain('[optional]');
  });

  it('tells the agent never to withhold an answer to get a value — required means ask, not block', () => {
    expect(renderIntakeInstructions([ORDER])).toContain(
      'Never withhold an answer',
    );
  });
});

describe('findBlockedTerm()', () => {
  // Asserting "blocked", not WHICH term matched: "One Time Password OTP"
  // legitimately trips `password` before `otp`, and pinning the winner would
  // make the test about blocklist ordering rather than about refusal.
  it.each([
    'card number',
    'CVV',
    'One Time Password OTP',
    'NID number',
    'passport no',
    'bank account number',
    'security code',
  ])('refuses %s', (label) => {
    expect(findBlockedTerm('some_key', label)).not.toBeNull();
  });

  it('allows ordinary support fields', () => {
    expect(findBlockedTerm('order_number', 'Order number')).toBeNull();
    expect(findBlockedTerm('delivery_area', 'Delivery area')).toBeNull();
    expect(findBlockedTerm('full_name', 'Full name')).toBeNull();
  });

  it('catches a blocked term hidden in the key even when the label looks innocent', () => {
    // The prompt renders both, and a tenant naming a field `card_no` with the
    // label "Reference" is still asking for a card number.
    expect(findBlockedTerm('card_no', 'Reference')).toBe('card');
  });

  it('caps how many fields an agent may collect', () => {
    expect(MAX_INTAKE_FIELDS).toBeLessThanOrEqual(10);
  });
});
