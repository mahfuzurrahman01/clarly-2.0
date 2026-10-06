// Persistence: the one correct way to ask "was that a unique-violation?".
//
// Drizzle does not rethrow the driver's error as-is — it wraps it in a
// `DrizzleQueryError` and hangs the original `pg` error off `.cause`. Code
// that reads `error.code` on the thrown value therefore never sees `23505`,
// and a handler meant to answer 409 silently falls through to a 500 instead.
// That is not hypothetical: it is exactly what `POST /templates` did until
// this helper replaced its local check.
//
// Both shapes are accepted so this keeps working if a caller ever catches the
// driver error directly.

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

interface PostgresErrorLike {
  code?: string;
  cause?: { code?: string };
}

export function isUniqueViolation(error: unknown): boolean {
  const candidate = error as PostgresErrorLike | null | undefined;
  return (
    candidate?.code === UNIQUE_VIOLATION ||
    candidate?.cause?.code === UNIQUE_VIOLATION
  );
}

/**
 * The name of the constraint a unique violation hit, when the driver reported
 * one. F25 needs this: `orders` carries three unique constraints that mean
 * three different things (a retried tool call, a racing second turn, and a
 * reference collision), and a writer that cannot tell them apart has to guess
 * which recovery to run. Returns null for anything that is not a unique
 * violation, so a caller can branch on it directly.
 */
export function uniqueViolationConstraint(error: unknown): string | null {
  if (!isUniqueViolation(error)) return null;
  const candidate = error as
    { constraint?: string; cause?: { constraint?: string } } | null | undefined;
  return candidate?.constraint ?? candidate?.cause?.constraint ?? null;
}
