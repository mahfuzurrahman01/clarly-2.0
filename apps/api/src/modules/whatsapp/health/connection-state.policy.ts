// Channel (WhatsappModule, Gulf T5 / D5): the one set of rules for moving a
// WhatsApp number between connection states. Pure, so every writer (send
// path, WABA webhooks, deauthorize callback, daily reconcile) shares it and
// it is tested once.
//
// Severity order: active < restricted < reconnect_required < disconnected.
//   - `restricted`: Meta is blocking or limiting sends (policy enforcement,
//     payment method, ban). Meta-side; can clear on its own, and the daily
//     reconcile restores it to active when health_status says so.
//   - `reconnect_required`: our token is dead or the number never finished
//     registering. Only the tenant running Embedded Signup again fixes it.
//   - `disconnected`: the WABA or its link to our app is gone (deleted,
//     unshared, offboarded). Also fixed by connecting again.
// A degrade never lowers severity: a restriction arriving for a number whose
// token is already dead must not replace the "reconnect" banner with a
// "restricted" one. Only an explicit restore (from a named set of states)
// returns a number to active.
import type { WhatsappConnectionState } from '../../persistence/drizzle/schema';

export interface ConnectionStatus {
  connectionState: WhatsappConnectionState;
  connectionError: string | null;
}

export type DegradedState = Exclude<WhatsappConnectionState, 'active'>;

export type ConnectionTransition =
  | { kind: 'degrade'; to: DegradedState; reason: string }
  | { kind: 'restore'; from: readonly DegradedState[] };

const SEVERITY: Record<WhatsappConnectionState, number> = {
  active: 0,
  restricted: 1,
  reconnect_required: 2,
  disconnected: 3,
};

/** Tenant-facing `connection_error` sentences, one per cause. Shown as-is by the console. */
export const CONNECTION_REASONS = {
  tokenRevoked:
    "Meta rejected this number's access token, so replies cannot be sent. Connect the number again with WhatsApp signup to continue.",
  appUninstalled:
    "Your business removed this app's access to the WhatsApp Business account in Meta Business Suite, so replies cannot be sent. Connect the number again to continue.",
  deauthorized:
    'The Facebook user who connected this number removed this app from their account, so its access no longer works. Connect the number again to continue.',
  wabaDeleted:
    'The WhatsApp Business account for this number was deleted in Meta. Connect a number again to continue.',
  partnerRemoved:
    'The WhatsApp Business account for this number is no longer shared with this app. Connect the number again to continue.',
  offboarded:
    'Meta disconnected this number from the API after a device change or re-registration on the WhatsApp Business app. Reconnect it on your phone, or connect the number again.',
  wabaDisabled:
    'Meta disabled the WhatsApp Business account for this number for a policy violation, so messages cannot be sent. Review it in WhatsApp Manager and request a review if you think this is wrong.',
} as const;

export function degrade(
  to: DegradedState,
  reason: string,
): ConnectionTransition {
  return { kind: 'degrade', to, reason };
}

export function restore(from: readonly DegradedState[]): ConnectionTransition {
  return { kind: 'restore', from };
}

/**
 * The status `current` moves to under `transition`, or null when the
 * transition does not apply (or would change nothing). Never mutates.
 */
export function applyTransition(
  current: ConnectionStatus,
  transition: ConnectionTransition,
): ConnectionStatus | null {
  if (transition.kind === 'restore') {
    const from: readonly WhatsappConnectionState[] = transition.from;
    return from.includes(current.connectionState)
      ? { connectionState: 'active', connectionError: null }
      : null;
  }

  if (SEVERITY[transition.to] < SEVERITY[current.connectionState]) {
    return null;
  }
  if (
    transition.to === current.connectionState &&
    transition.reason === current.connectionError
  ) {
    return null;
  }
  return { connectionState: transition.to, connectionError: transition.reason };
}
