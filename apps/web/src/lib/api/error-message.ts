import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { ApiError } from "./client";

/**
 * Turns a caught error into a user-facing, translated message.
 *
 * - Network failures (`ApiError` with `status === 0`, see client.ts) never
 *   show the raw fetch/DNS detail — that's logged separately, dev-only, at
 *   the throw site. Users get a generic, translated "can't reach the
 *   server" message instead.
 * - Other `ApiError`s carry a message the API meant for the end user
 *   (validation errors, etc.), so it's shown as-is.
 * - Anything else falls back to the caller-provided, already-translated
 *   fallback string.
 */
export function apiErrorMessage(
  err: unknown,
  t: Dictionary,
  fallback: string,
): string {
  if (err instanceof ApiError) {
    return err.status === 0 ? t.common.networkError : err.message || fallback;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}
