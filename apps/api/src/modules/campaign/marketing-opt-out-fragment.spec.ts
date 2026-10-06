import {
  MARKETING_OPT_OUT_FRAGMENT,
  appendMarketingOptOutFragment,
} from './marketing-opt-out-fragment';

describe('appendMarketingOptOutFragment', () => {
  it('appends the shared fragment after a blank line', () => {
    const result = appendMarketingOptOutFragment('Your order shipped!');
    expect(result).toBe(`Your order shipped!\n\n${MARKETING_OPT_OUT_FRAGMENT}`);
  });

  it('mentions both recognised keywords, matching the inbound handler', () => {
    expect(MARKETING_OPT_OUT_FRAGMENT).toMatch(/STOP MARKETING/i);
    expect(MARKETING_OPT_OUT_FRAGMENT).toMatch(/UNSUBSCRIBE/i);
  });
});
