import { asksForHumanContact, holdingReplyFor } from './handover-holding-reply';

describe('asksForHumanContact()', () => {
  it.each([
    'I want to talk with management',
    'can I speak to a human please',
    'Get me a real person',
    'I need to talk to the manager',
    'أريد التحدث مع الإدارة',
    'ابغى اكلم موظف',
    'اريد مدير',
  ])('detects %p', (text) => {
    expect(asksForHumanContact(text)).toBe(true);
  });

  it.each(['where is my order?', 'thanks', 'ok', 'كم السعر'])(
    'ignores %p',
    (text) => {
      expect(asksForHumanContact(text)).toBe(false);
    },
  );
});

describe('holdingReplyFor()', () => {
  it('answers in English for Latin-script text', () => {
    expect(holdingReplyFor('I want management')).toMatch(/team member/i);
  });
  it('answers in Arabic for Arabic-script text', () => {
    expect(holdingReplyFor('أريد التحدث مع المدير')).toMatch(/[؀-ۿ]/);
  });
});
