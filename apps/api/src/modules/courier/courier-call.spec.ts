// F26 (D2): the retry + circuit-breaker wrapper every adapter call goes
// through. Courier APIs are the slowest and least reliable dependency in the
// stack, so the behaviour under test is "how do we stop hammering one that is
// already down" and "what must never be retried".
import {
  CIRCUIT_FAILURE_THRESHOLD,
  CIRCUIT_HALF_OPEN_AFTER_MS,
  CourierCallGuard,
  CourierCircuitOpenError,
} from './courier-call';
import { CourierAuthenticationError } from './ports/courier-connector.port';

const noSleep = () => Promise.resolve();

describe('CourierCallGuard', () => {
  it('returns the first success without retrying', async () => {
    const guard = new CourierCallGuard();
    const call = jest.fn().mockResolvedValue('ok');

    await expect(guard.run('k', call, { sleep: noSleep })).resolves.toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure up to the attempt bound, then gives up', async () => {
    const guard = new CourierCallGuard();
    const call = jest.fn().mockRejectedValue(new Error('timeout'));

    await expect(
      guard.run('k', call, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toThrow('timeout');
    expect(call).toHaveBeenCalledTimes(3);
  });

  // Bad credentials are not a transient condition, and retrying them is how
  // an account gets locked out. They must also leave the breaker untouched,
  // so one merchant's wrong password cannot open the circuit.
  it('never retries an authentication failure and never counts it', async () => {
    const guard = new CourierCallGuard();
    const call = jest
      .fn()
      .mockRejectedValue(new CourierAuthenticationError('aramex', 'nope'));

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD + 1; i += 1) {
      await expect(
        guard.run('k', call, { sleep: noSleep }),
      ).rejects.toBeInstanceOf(CourierAuthenticationError);
    }

    expect(call).toHaveBeenCalledTimes(CIRCUIT_FAILURE_THRESHOLD + 1);
    expect(guard.isOpen('k')).toBe(false);
  });

  it('opens after the threshold and refuses further calls', async () => {
    const guard = new CourierCallGuard();
    const call = jest.fn().mockRejectedValue(new Error('503'));
    const now = 1_000;

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await expect(
        guard.run('k', call, {
          maxAttempts: 1,
          sleep: noSleep,
          now: () => now,
        }),
      ).rejects.toThrow('503');
    }

    const callsBefore = call.mock.calls.length;
    await expect(
      guard.run('k', call, { maxAttempts: 1, sleep: noSleep, now: () => now }),
    ).rejects.toBeInstanceOf(CourierCircuitOpenError);
    // The point of the breaker: the courier is not called at all.
    expect(call).toHaveBeenCalledTimes(callsBefore);
  });

  it('half-opens after the cooldown and a success clears it', async () => {
    const guard = new CourierCallGuard();
    const failing = jest.fn().mockRejectedValue(new Error('503'));
    let now = 1_000;

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await expect(
        guard.run('k', failing, {
          maxAttempts: 1,
          sleep: noSleep,
          now: () => now,
        }),
      ).rejects.toThrow('503');
    }

    now += CIRCUIT_HALF_OPEN_AFTER_MS;
    const recovered = jest.fn().mockResolvedValue('ok');
    await expect(
      guard.run('k', recovered, { sleep: noSleep, now: () => now }),
    ).resolves.toBe('ok');
    expect(guard.isOpen('k', now)).toBe(false);
  });

  // One breaker per key, because the key is `${courier}:${connectionId}` at
  // every call site: one merchant's dead account must not stop every other
  // merchant on the same courier.
  it('keeps circuits independent per key', async () => {
    const guard = new CourierCallGuard();
    const failing = jest.fn().mockRejectedValue(new Error('503'));
    const now = () => 1_000;

    for (let i = 0; i < CIRCUIT_FAILURE_THRESHOLD; i += 1) {
      await expect(
        guard.run('aramex:conn-a', failing, {
          maxAttempts: 1,
          sleep: noSleep,
          now,
        }),
      ).rejects.toThrow('503');
    }

    expect(guard.isOpen('aramex:conn-a', 1_000)).toBe(true);
    await expect(
      guard.run('aramex:conn-b', () => Promise.resolve('ok'), {
        sleep: noSleep,
        now,
      }),
    ).resolves.toBe('ok');
  });
});
