// Platform (CoreModule): clock abstraction. Every call site that needs "now"
// (T4 stuck-ticket timers, T10 debounce windows, T12 retention purge, D7 24h
// WA window) injects Clock instead of calling `new Date()`/`Date.now()`
// directly, so tests can bind a FakeClock and advance time deterministically
// without real sleeps or timer mocking gymnastics.
export abstract class Clock {
  abstract now(): Date;
  abstract nowMs(): number;
}
