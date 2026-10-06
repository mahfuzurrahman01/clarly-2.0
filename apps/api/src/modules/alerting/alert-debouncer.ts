// AlertingModule (Feature 7/8, T18): "no duplicate/flapping alerts on
// sustained conditions." Every sweep in this module runs on a fixed
// interval and re-evaluates the SAME condition each time — without this,
// a circuit breaker that stays open for an hour would fire a fresh alert
// every single sweep cycle for that whole hour. `AlertDebouncer` tracks
// whether each keyed condition was already active last time it was
// checked: `shouldFire()` returns true only on the false -> true edge
// (the moment a condition starts being bad), stays quiet while it remains
// bad, and re-arms the moment it recovers (false) so a later re-trigger
// fires again for real.
//
// In-memory, single-instance only — same documented limitation as
// `TicketEventsService`'s SSE bus and `StuckTicketAlertEventsService`'s
// in-process EventEmitter (Feature 5/7): correct for exactly one API
// process, not yet safe to assume across a horizontally-scaled
// deployment. Flagged here, not silently assumed away.
import { Injectable } from '@nestjs/common';

@Injectable()
export class AlertDebouncer {
  private readonly activeKeys = new Set<string>();

  /**
   * @param key Unique per condition instance — e.g. `breaker-open`,
   *   `queue-depth:respond-path`, `tool-scope-violation:${tenantId}`.
   * @param isActive Whether the condition is bad right now.
   * @returns true only on the transition from not-active to active.
   */
  shouldFire(key: string, isActive: boolean): boolean {
    const wasActive = this.activeKeys.has(key);
    if (isActive) {
      this.activeKeys.add(key);
    } else {
      this.activeKeys.delete(key);
    }
    return isActive && !wasActive;
  }
}
