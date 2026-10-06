import { SystemClock } from './system-clock';

describe('SystemClock', () => {
  it('now() returns a real Date close to the current wall-clock time', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const observed = clock.now().getTime();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it('nowMs() returns a millisecond timestamp close to Date.now()', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const observed = clock.nowMs();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});
