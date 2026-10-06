/**
 * Copy for the public landing page. Kept apart from the general i18n
 * Dictionary (lib/i18n/dictionaries) for the same reason lib/tickets/escalation.ts
 * is: the page needs ordered lists and structured demo data (notifications,
 * plans, FAQs), which the Dictionary's string-leaf shape can't express. Both
 * locales are typed against this one shape, so a missing translation fails to
 * compile.
 */

/** A run of text; `em` marks the emphasised word(s) in a heading. */
export type Inline = { text: string; em?: boolean };

export type ChatChrome = {
  clinic: string;
  /** Avatar letter for the clinic (the brand's first letter, not the word "clinic"). */
  initial: string;
  status: string;
  placeholder: string;
};

export type Review = { quote: string; name: string; role: string; initial: string };

export type Plan = {
  name: string;
  badge?: string;
  /** Monthly price for each billing period; omit for free/custom plans and use priceLabel. */
  price?: { monthly: number; yearly: number };
  priceLabel?: string;
  description: string;
  features: string[];
  cta: string;
  featured?: boolean;
};

export type InboxStatus = "answered" | "handedOff" | "claimed";

export type LandingContent = {
  nav: { story: string; platform: string; pricing: string; faq: string };
  rail: { label: string };

  night: {
    chapter: string;
    eyebrow: string;
    title: Inline[][];
    lede: string;
    /** Secondary hero action; the primary one (waitlist or signup) comes from the page. */
    howItWorks: string;
    note: string;
    phoneLabel: string;
    day: string;
    unreadLabel: string;
    /** Newest first — the order they stack on the lock screen. */
    notifications: { name: string; time: string; text: string; lost?: boolean }[];
    captionsLabel: string;
    captions: { time: string; text: string; em?: string }[];
    dawnEyebrow: string;
    dawnTitle: string;
    scrollCue: string;
  };

  knowledge: {
    chapter: string;
    eyebrow: string;
    title: Inline[];
    body: string;
    docsLabel: string;
    passagesLabel: string;
    kbTitle: string;
    kbOwner: string;
    ready: string;
    passagesWord: string;
    readWord: string;
    docs: { name: string; passages: number }[];
  };

  answer: {
    chapter: string;
    eyebrow: string;
    title: Inline[];
    body: string;
    timeline: { time: string; text: string }[];
    phoneLabel: string;
    chat: ChatChrome & { time: string; question: string; reply: string; cite: string; meta: string };
    sources: { file: string; before: string; mark?: string; after?: string; unused?: boolean }[];
  };

  handoff: {
    chapter: string;
    eyebrow: string;
    title: Inline[];
    body: string;
    guardsLabel: string;
    guards: string[];
    /** Index in `guards` of the topic this conversation trips. */
    hitGuard: number;
    phoneLabel: string;
    chat: ChatChrome & {
      time: string;
      previous: { text: string; time: string };
      question: string;
      reply: string;
      tag: string;
      nurseName: string;
      nurse: string;
      nurseTime: string;
    };
    gauge: { label: string; ruleBefore: string; ruleAfter: string };
    board: {
      columns: [string, string, string];
      ticket: {
        id: string;
        title: string;
        reason: string;
        waiting: string;
        statusNew: string;
        statusClaimed: string;
        statusResolved: string;
        claimerInitial: string;
      };
      claimed: { id: string; time: string; title: string; reason: string; who: string; initial: string };
      resolved: { id: string; time: string; title: string; reason: string; who: string; initial: string };
    };
    note: string;
  };

  principle: { chapter: string; eyebrow: string; words: Inline[]; body: string };

  language: { chapter: string; eyebrow: string; title: Inline[]; body: string };

  platform: {
    chapter: string;
    eyebrow: string;
    title: string;
    body: string;
    rules: { title: string; body: string; addTopic: string; threshold: string };
    inbox: {
      title: string;
      body: string;
      rows: { initial: string; name: string; preview: string; status: InboxStatus }[];
      status: Record<InboxStatus, string>;
    };
    gaps: { title: string; body: string; bars: { label: string; value: number }[] };
    templates: { title: string; body: string; template: string; approved: string };
    audit: { title: string; body: string; lines: { time: string; text: string }[] };
    hooks: { title: string; body: string; flows: { event: string; target: string }[] };
  };

  numbers: { title: string; sample: string; stats: { value: number; suffix?: string; label: string }[] };

  setup: {
    chapter: string;
    eyebrow: string;
    title: string;
    stepWord: string;
    steps: { title: string; body: string }[];
    upload: { files: { name: string; count: number }[] };
    rules: { tones: { label: string; on: boolean }[]; threshold: string };
    connect: { checks: { label: string; meta: string; done: boolean }[] };
    live: { label: string; agent: string; version: string };
  };

  reviews: { eyebrow: string; title: string; sample: string; rows: [Review[], Review[]] };

  pricing: {
    chapter: string;
    eyebrow: string;
    title: string;
    body: string;
    periodLabel: string;
    monthly: string;
    yearly: string;
    yearlyNote: string;
    currency: string;
    currencyPosition: "before" | "after";
    perMonth: string;
    plans: Plan[];
    note: string;
  };

  faq: { chapter: string; eyebrow: string; title: string; body: string; items: { q: string; a: string }[] };

  cta: {
    eyebrow: string;
    title: Inline[];
    body: string;
    phoneLabel: string;
    chatsTitle: string;
    waitingLabel: string;
    chats: { initial: string; name: string; preview: string; time: string }[];
  };
};
