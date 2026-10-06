import { RealSleep } from './real-sleep';

describe('RealSleep.wait()', () => {
  it('resolves after roughly the requested delay', async () => {
    const sleep = new RealSleep();
    const start = Date.now();

    await sleep.wait(20);

    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('resolves immediately for a zero or negative delay, without scheduling a timer', async () => {
    const sleep = new RealSleep();

    await expect(sleep.wait(0)).resolves.toBeUndefined();
    await expect(sleep.wait(-5)).resolves.toBeUndefined();
  });
});
