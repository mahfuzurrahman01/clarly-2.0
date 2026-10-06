// EmailModule (gap #3): the provider-portability port for mail the product
// itself originates.
//
// Deliberately narrow. Password reset, email verification and team invites
// are Supabase Auth flows — Supabase composes and sends those through the
// project's own SMTP settings, and routing them through here would mean
// reimplementing three flows that already work. What had no channel at all
// was product mail: an escalated ticket nobody has picked up produced a
// notification row and nothing else, so the promise the product is built on
// (a human takes over) failed silently outside office hours.
//
// A port rather than direct provider calls, for the same reason
// LlmProvider/ObjectStorage are ports: swapping Resend for SES, or standing
// up a test double, is a binding change and never a call-site change.

/** One message to one recipient set. Plain text is required, HTML optional — a mail client that cannot render HTML must still get the whole story, and the text part is what a screen reader and a notification preview read. */
export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSendResult {
  /** The provider's own id for the message, when it gives one — the only handle support has for tracing a mail that never arrived. */
  providerMessageId: string | null;
}

export abstract class EmailSender {
  /**
   * Whether this binding can actually deliver.
   *
   * Callers check this before composing. It exists so the no-op binding can
   * fail *closed* without turning every alert in a local or unconfigured
   * environment into an error log: a caller that asks first gets an honest
   * "no", and a caller that sends anyway gets an exception rather than a
   * silent success that nobody would ever notice.
   */
  abstract isEnabled(): boolean;

  /** Rejects on any delivery failure. Never resolves for a message the provider refused. */
  abstract send(message: EmailMessage): Promise<EmailSendResult>;
}
