// Channel (WhatsappModule): D7's "WA 24h window... derived from
// last_inbound_at, evaluated at send time."
//
// Meta only accepts free-form text within 24 hours of the customer's last
// inbound message. Outside it, a send is rejected and only an approved
// template message goes through. This is the single most surprising rule in
// WhatsApp business messaging, and the failure is silent from a human's
// point of view — they type a reply, hit send, and it never arrives.
//
// A pure function on purpose: the respond path, the console API, and (later)
// the send path all have to agree on one definition of "open", and each
// evaluates it at a different moment.
export const CUSTOMER_SERVICE_WINDOW_HOURS = 24;

const WINDOW_MS = CUSTOMER_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;

export interface CustomerServiceWindow {
  /** Free-form replies are accepted right now. */
  open: boolean;
  /** When the window shuts (24h after the last inbound message). Already in the past when `open` is false. */
  expiresAt: Date;
}

export function customerServiceWindow(
  lastInboundAt: Date,
  now: Date,
): CustomerServiceWindow {
  const expiresAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: now.getTime() < expiresAt.getTime(), expiresAt };
}
