import { acknowledgesCustomerDistress } from './distress-acknowledgement';

describe('acknowledgesCustomerDistress', () => {
  it('matches the measured miss: the model names the customer as frustrated and answers anyway', () => {
    expect(
      acknowledgesCustomerDistress(
        'I understand you are frustrated with the service. To help you resolve the ' +
          'issue with your order, please provide your order ID.',
      ),
    ).toBe(true);
  });

  it.each([
    'I understand that you are very angry about this.',
    'I am sorry you are upset with the delay.',
    'You seem really annoyed, and I want to help.',
    'I can see you are panicking about the delivery.',
    'You sound understandably irritated.',
  ])('matches a direct second-person distress statement: %s', (answer) => {
    expect(acknowledgesCustomerDistress(answer)).toBe(true);
  });

  it.each([
    // Polite boilerplate: extremely common on calm turns, and deliberately not
    // matched — it says nothing about the customer's state.
    'I am sorry for the inconvenience caused by the delay.',
    'I understand your frustration with the process.',
    'We apologise for any frustration this may have caused.',
    'Sorry about that! Your order ships in 2 days.',
    'Returns are accepted within 30 days of delivery.',
    // Third parties and the agent itself are not the customer.
    'The courier was annoyed by the traffic.',
    'I am frustrated that I cannot find this in our records.',
  ])('does not match: %s', (answer) => {
    expect(acknowledgesCustomerDistress(answer)).toBe(false);
  });
});
