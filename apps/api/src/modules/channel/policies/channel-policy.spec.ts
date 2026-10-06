// Feature 16: the ChannelPolicy abstraction — the thing that replaced D9's
// hardcoded WhatsApp 24h rule.
//
// The point of every case below is that WhatsApp's rule is now ONE of three,
// not the definition of "the window". A regression here looks like a support
// agent being told they cannot reply to an Instagram DM they demonstrably
// can, or an automated send quietly claiming HUMAN_AGENT.
import {
  ChannelPolicyRegistry,
  UnsupportedChannelError,
} from '../channel-policy.registry';
import {
  HUMAN_AGENT_TAG,
  InstagramChannelPolicy,
  MessengerChannelPolicy,
} from './meta-social-channel.policy';
import { WebChannelPolicy } from './web-channel.policy';
import { WhatsappChannelPolicy } from './whatsapp-channel.policy';

const NOW = new Date('2026-09-06T12:00:00Z');
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const registry = new ChannelPolicyRegistry(
  new WhatsappChannelPolicy(),
  new MessengerChannelPolicy(),
  new InstagramChannelPolicy(),
  new WebChannelPolicy(),
);

describe('ChannelPolicyRegistry', () => {
  it('resolves a policy for every supported channel', () => {
    for (const channel of ['whatsapp', 'messenger', 'instagram'] as const) {
      expect(registry.for(channel).channel).toBe(channel);
    }
  });

  it('throws rather than silently falling back to WhatsApp rules for an unknown channel', () => {
    // The fallback would be the dangerous behaviour: a channel with a
    // 1-hour window silently evaluated against WhatsApp's 24 would produce
    // sends the provider rejects, with no local trace of why.
    expect(() => registry.for('telegram' as unknown as 'whatsapp')).toThrow(
      UnsupportedChannelError,
    );
  });
});

describe('WhatsappChannelPolicy (D9, unchanged behaviour)', () => {
  const policy = registry.for('whatsapp');

  it('is open inside 24 hours and shut after', () => {
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(23), now: NOW }).open,
    ).toBe(true);
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(25), now: NOW }).open,
    ).toBe(false);
  });

  it('offers a template — and only a template — outside the window', () => {
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(25), now: NOW })
        .outOfWindowOptions,
    ).toEqual(['template']);
  });

  it('gives a human agent no extension: WhatsApp does not have one', () => {
    const window = policy.evaluate({
      lastInboundAt: hoursAgo(30),
      now: NOW,
      humanAgent: true,
    });
    expect(window.open).toBe(false);
    expect(
      policy.outOfWindowTag({ lastInboundAt: hoursAgo(30), now: NOW }),
    ).toBeNull();
  });
});

describe('MessengerChannelPolicy', () => {
  const policy = registry.for('messenger');

  it('is open inside the standard 24-hour window', () => {
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(20), now: NOW }).open,
    ).toBe(true);
  });

  it('extends to 7 days for a human agent, and reports the window as genuinely OPEN', () => {
    // Not "shut with an exception": inside the extension a human's reply is
    // an ordinary accepted send. Reporting it shut would make the console
    // refuse a reply Meta would have delivered.
    const window = policy.evaluate({
      lastInboundAt: hoursAgo(72),
      now: NOW,
      humanAgent: true,
    });
    expect(window.open).toBe(true);
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(72), now: NOW }).open,
    ).toBe(false);
  });

  it('tags a human-agent send with HUMAN_AGENT, and never tags an automated one', () => {
    const at = { lastInboundAt: hoursAgo(72), now: NOW };
    expect(policy.outOfWindowTag({ ...at, humanAgent: true })).toBe(
      HUMAN_AGENT_TAG,
    );
    // The agent has no honest tag to claim. Inventing one is a Meta policy
    // violation, not merely a rejected request.
    expect(policy.outOfWindowTag(at)).toBeNull();
  });

  it('offers transactional message tags outside the window', () => {
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(30), now: NOW })
        .outOfWindowOptions,
    ).toEqual(['message_tag', 'human_agent']);
  });
});

describe('InstagramChannelPolicy', () => {
  const policy = registry.for('instagram');

  it('does NOT offer Messenger transactional tags — Instagram rejects them', () => {
    expect(
      policy.evaluate({ lastInboundAt: hoursAgo(30), now: NOW })
        .outOfWindowOptions,
    ).toEqual(['human_agent']);
  });

  it('still honours the 7-day human-agent extension', () => {
    expect(
      policy.evaluate({
        lastInboundAt: hoursAgo(100),
        now: NOW,
        humanAgent: true,
      }).open,
    ).toBe(true);
  });

  it('shuts after 7 days even for a human agent', () => {
    expect(
      policy.evaluate({
        lastInboundAt: hoursAgo(24 * 8),
        now: NOW,
        humanAgent: true,
      }).open,
    ).toBe(false);
  });
});

// Feature 16's "unified inbox" exit criterion, at the contract level: the
// console reads ONE window shape for every channel and never computes a
// channel's rules itself. These assert the exact values the inbox renders.
describe('reply window as the unified inbox reads it', () => {
  const lastInboundAt = hoursAgo(48);
  // The inbox evaluates for a HUMAN agent — the only reader of the field is a
  // person about to reply, and HumanReplyService evaluates it identically, so
  // the console can never show a window the send path then refuses.
  const asInbox = (channel: 'whatsapp' | 'messenger' | 'instagram') =>
    registry
      .for(channel)
      .evaluate({ lastInboundAt, now: NOW, humanAgent: true });

  it('shows a 48-hour-old WhatsApp thread as shut, offering a template', () => {
    expect(asInbox('whatsapp')).toMatchObject({
      channel: 'whatsapp',
      open: false,
      outOfWindowOptions: ['template'],
    });
  });

  it('shows the same-age Messenger and Instagram threads as still repliable by a human', () => {
    // The behaviour a WhatsApp-only console would get wrong: refusing a reply
    // Meta would have delivered.
    expect(asInbox('messenger').open).toBe(true);
    expect(asInbox('instagram').open).toBe(true);
  });
});
