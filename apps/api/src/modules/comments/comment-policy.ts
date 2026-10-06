// Gulf T8 (F23, D11): the tiered filter's decisions, as pure functions.
//
//   tier 1  rules      prefilterComment()   spam keyword / trigger keyword / nothing to answer
//   tier 2  classify   parseCommentIntent() the cheap model call's answer, parsed
//   tier 3  agent      decideForIntent()    only purchase/question (as enabled) reach the agent
//
// Kept DI-free (like escalation-decision.ts and customer-label-derivation.ts)
// so every branch is unit-testable without a database, a queue or a model.
import type {
  AgentCustomerLabel,
  CommentDecision,
  CommentReplyIntent,
} from '../persistence/drizzle/schema';
import { findKeyword, hasMeaningfulText } from './comment-text';

/** What the classifier may answer. Anything else parses as `other`. */
export const COMMENT_INTENTS = [
  'purchase',
  'question',
  'complaint',
  'spam',
  'abuse',
  'other',
] as const;
export type CommentIntent = (typeof COMMENT_INTENTS)[number];

/** Recorded as `comment_events.intent` when a trigger keyword decided, so the ledger says why no classifier ran. */
export const KEYWORD_TRIGGER_INTENT = 'keyword';

/**
 * Meta allows a private reply within 7 days of the comment. We stop an hour
 * short: a job deferred by the Instagram limiter must not reach Meta a second
 * after the window shut and burn the claim on a refusal.
 */
export const PRIVATE_REPLY_WINDOW_MS = (7 * 24 - 1) * 60 * 60 * 1000;

export interface PrefilterRules {
  keywordTriggers: readonly string[];
  spamKeywords: readonly string[];
}

export type PrefilterResult =
  | { kind: 'spam'; matched: string }
  | { kind: 'trigger'; matched: string }
  | { kind: 'ignore'; reason: 'no_text' }
  | { kind: 'classify' };

/**
 * Tier 1. Spam wins over a trigger: "price? earn crypto" is a spammer using
 * the buying word, and answering it would put a DM in a bot's inbox.
 */
export function prefilterComment(
  text: string,
  rules: PrefilterRules,
): PrefilterResult {
  const spam = findKeyword(text, rules.spamKeywords);
  if (spam) return { kind: 'spam', matched: spam };
  const trigger = findKeyword(text, rules.keywordTriggers);
  if (trigger) return { kind: 'trigger', matched: trigger };
  if (!hasMeaningfulText(text)) return { kind: 'ignore', reason: 'no_text' };
  return { kind: 'classify' };
}

/**
 * Tier 2's answer, read leniently: the first known intent word in the
 * model's output, else `other`. A model that rambles degrades to "do
 * nothing", never to a reply.
 */
export function parseCommentIntent(raw: string): CommentIntent {
  const words: string[] = raw.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.find(isCommentIntent) ?? 'other';
}

function isCommentIntent(word: string): word is CommentIntent {
  return (COMMENT_INTENTS as readonly string[]).includes(word);
}

export interface DecisionRules {
  replyIntents: readonly CommentReplyIntent[];
  hideSpam: boolean;
}

/** Tier 3 gate: which intents get the full agent, which get hidden. */
export function decideForIntent(
  intent: CommentIntent,
  rules: DecisionRules,
): CommentDecision {
  if (intent === 'spam' || intent === 'abuse') {
    return rules.hideSpam ? 'hide' : 'none';
  }
  return (rules.replyIntents as readonly string[]).includes(intent)
    ? 'reply'
    : 'none';
}

export function canSendPrivateReply(
  commentCreatedAt: Date,
  now: Date,
): boolean {
  return now.getTime() - commentCreatedAt.getTime() <= PRIVATE_REPLY_WINDOW_MS;
}

/**
 * Feature 18's label vocabulary for a comment's intent, applied to the
 * customer when they answer the private reply (D15b). A buying signal is
 * `hot`, a question `warm`; anything else says nothing about the customer.
 */
export function labelForCommentIntent(
  intent: string | null,
): AgentCustomerLabel | null {
  if (intent === 'purchase' || intent === KEYWORD_TRIGGER_INTENT) return 'hot';
  if (intent === 'question') return 'warm';
  return null;
}
