// Platform (CoreModule): sleep abstraction, same rationale as Clock — any
// call site that needs to wait (A4's retry backoff, T10's debounce
// coalescing later) injects Sleep instead of calling `setTimeout` directly,
// so tests can bind a FakeSleep that resolves instantly instead of paying
// for real wall-clock delays or fighting Jest's timer mocks.
export abstract class Sleep {
  abstract wait(ms: number): Promise<void>;
}
