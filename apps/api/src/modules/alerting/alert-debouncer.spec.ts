import { AlertDebouncer } from './alert-debouncer';

describe('AlertDebouncer.shouldFire()', () => {
  it('fires on the first transition into an active condition', () => {
    const debouncer = new AlertDebouncer();

    expect(debouncer.shouldFire('k1', true)).toBe(true);
  });

  it('does not fire again while the condition stays active (no flapping on a sustained condition)', () => {
    const debouncer = new AlertDebouncer();

    debouncer.shouldFire('k1', true);

    expect(debouncer.shouldFire('k1', true)).toBe(false);
    expect(debouncer.shouldFire('k1', true)).toBe(false);
  });

  it('never fires while the condition is inactive', () => {
    const debouncer = new AlertDebouncer();

    expect(debouncer.shouldFire('k1', false)).toBe(false);
  });

  it('re-arms after the condition clears, firing again on the next transition', () => {
    const debouncer = new AlertDebouncer();

    debouncer.shouldFire('k1', true);
    debouncer.shouldFire('k1', false);

    expect(debouncer.shouldFire('k1', true)).toBe(true);
  });

  it('tracks each key independently', () => {
    const debouncer = new AlertDebouncer();

    debouncer.shouldFire('k1', true);

    expect(debouncer.shouldFire('k2', true)).toBe(true);
  });
});
