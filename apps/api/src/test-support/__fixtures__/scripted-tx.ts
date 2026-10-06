// A drizzle-shaped transaction for unit tests that need a `withTenantTx`
// callback to actually RUN (so a test can see what it does inside the
// transaction) without emulating SQL. Every builder call returns the same
// chain; awaiting the chain yields the next scripted result, in order.
//
// Under `__fixtures__` so it is excluded from the build and from coverage.

export function scriptedTx(script: unknown[]): unknown {
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const next = script.shift();
          return (
            resolve: (value: unknown) => void,
            reject: (reason: unknown) => void,
          ) => (next instanceof Error ? reject(next) : resolve(next));
        }
        return () => chain;
      },
    },
  );
  return chain;
}
