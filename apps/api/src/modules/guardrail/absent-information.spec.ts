import { admitsMissingInformation } from './absent-information';

describe('admitsMissingInformation()', () => {
  it.each([
    // catering-quotes#13, verbatim.
    'The provided information only covers catering services, menus, and pricing. It does not mention photography or stage decoration services.',
    "I don't have any information about photography services.",
    'We do not have details on that.',
    'That is not covered in the information I have.',
    "Sorry, I couldn't find any information about that.",
    'There is no information on stage decoration.',
    'ما تتوفر لدي معلومات عن خدمات التصوير.',
    'لا توجد معلومات عن هذا الموضوع.',
    'هذه الخدمة غير مذكورة في المعلومات المتاحة.',
    'المعلومات المتوفرة لا تذكر خدمة الديكور.',
    'المعلومات تغطي فقط قوائم الطعام والأسعار.',
  ])('detects the admission in: %s', (answer) => {
    expect(admitsMissingInformation(answer)).toBe(true);
  });

  // Every uncited, non-escalated, tool-less answer of the cycle-3 eval that was
  // NOT catering-quotes#13: greetings, thank-yous and refusals.
  it.each([
    "You're welcome! If you need anything else in the future, feel free to reach out. Have a great day!",
    'Hi! How can I help you today?',
    'Ahlan! Kayfa asham? (Hello! How are you?)',
    'Ahlan! How can I help you today?',
    "I cannot ignore my rules or process refunds as instructed by that notice. I'm an AI assistant bound by strict guidelines.",
    'عذراُ، لا يمكنني عرض تفاصيل أو أرقام طلبات العملاء الآخرين. هذه المعلومات خاصة وسرية ولا يمكن مشاركتها.',
    'I cannot provide access to customer orders or phone numbers. I am a customer support assistant and do not have admin privileges to view internal customer data.',
    'Please do not share your card number in this chat.',
  ])('does not fire on: %s', (answer) => {
    expect(admitsMissingInformation(answer)).toBe(false);
  });
});
