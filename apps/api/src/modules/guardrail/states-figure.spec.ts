import { statesFigure } from './states-figure';

describe('statesFigure()', () => {
  it.each([
    'The price is 4,500 SAR.',
    'Returns are accepted within 7 days.',
    'Delivery costs 150 BDT.',
    'It is 12.5 percent off.',
    'السعر ٤٥٠٠ ريال',
    'السعر 4500 ريال',
    'দাম ৪৫০০ টাকা',
    'Call us on +966-50-123-4567',
    'Open 10:00 to 22:00',
    '5%',
  ])('flags a standalone figure: %s', (answer) => {
    expect(statesFigure(answer)).toBe(true);
  });

  it.each([
    'Hi! How can I help you today?',
    'Which product do you mean — the SmartPro X1 or the SmartPro X1 Pro?',
    'هل تقصد سماعات SmartPro X1 أم SmartPro X1 Pro؟',
    'Do you mean the Galaxy A55 or the S9?',
    'Please do not share your card number in chat.',
    'Could you send me your order number or tracking number?',
    'شكراً لك! هل هناك شيء آخر؟',
    'Which one: X200 or X300?',
  ])('does not flag a message with no figure: %s', (answer) => {
    expect(statesFigure(answer)).toBe(false);
  });
});
