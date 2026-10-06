const API_BASE = process.env.NEXT_PUBLIC_API_URL!;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Substring of the message `EntitlementGuard` (apps/api) throws on every
 * gated route once a tenant's subscription is no longer `active`/`trialing`.
 * Matched by substring, not equality, because the guard appends actionable
 * copy after it ("... — update billing to continue").
 */
const SUBSCRIPTION_INACTIVE_MESSAGE = "Subscription is not active";

export function isSubscriptionInactiveError(err: unknown): err is ApiError {
  return (
    err instanceof ApiError &&
    err.status === 403 &&
    err.message.includes(SUBSCRIPTION_INACTIVE_MESSAGE)
  );
}

type SubscriptionInactiveListener = () => void;
const subscriptionInactiveListeners = new Set<SubscriptionInactiveListener>();

/**
 * Global, DRY hook point for the "subscription is not active" 403. Any
 * browser-side API call that hits this gate notifies every subscriber —
 * today that's a single upgrade-prompt dialog mounted once in the app
 * shell, so every gated write anywhere in the console gets the same
 * "upgrade to continue" UI instead of a generic error toast, without every
 * call site having to know about it.
 */
export function onSubscriptionInactive(
  listener: SubscriptionInactiveListener,
): () => void {
  subscriptionInactiveListeners.add(listener);
  return () => subscriptionInactiveListeners.delete(listener);
}

function notifySubscriptionInactive(): void {
  for (const listener of subscriptionInactiveListeners) listener();
}

/**
 * Lets calls that can't go through `apiFetch` — multipart uploads, binary
 * responses — reuse the same gate as everything else instead of swallowing
 * the "subscription is not active" 403 silently.
 */
export function reportIfSubscriptionInactive(err: unknown): void {
  if (isSubscriptionInactiveError(err)) notifySubscriptionInactive();
}

/** Base URL of the NestJS API, for the same non-JSON calls. */
export const API_BASE_URL = API_BASE;

/**
 * The browser's current Supabase access token. For requests `apiFetch` can't
 * express (a multipart body, a blob response) but that still need the bearer.
 */
export async function browserAccessToken(): Promise<string> {
  const { createClient } = await import("@/lib/supabase/client");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not signed in");
  return session.access_token;
}

type ApiFetchOptions = Omit<RequestInit, "body"> & {
  /** Supabase access token to send as `Authorization: Bearer <token>`. */
  token?: string;
  /** JSON-serialisable body. */
  json?: unknown;
};

/**
 * Thin wrapper over fetch for the NestJS API: attaches the bearer token, sends
 * JSON, and turns non-2xx responses into a typed ApiError carrying the API's
 * own message when it sends one.
 */
export async function apiFetch<T = unknown>(
  path: string,
  { token, json, headers, ...init }: ApiFetchOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch (cause) {
    // Network-level failure (API down, wrong port, DNS). status 0 is the
    // sentinel callers check for — the message itself is not meant to be
    // shown to users (see apiErrorMessage in ./error-message, which maps
    // it to a translated, user-friendly string). The real cause is logged
    // here, dev-only, since a raw ECONNREFUSED/fetch-failed reads like an
    // auth bug to whoever is debugging otherwise.
    if (process.env.NODE_ENV !== "production") {
      console.error(`[apiFetch] network error reaching ${API_BASE}${path}`, cause);
    }
    throw new ApiError(0, "NETWORK_ERROR");
  }

  if (!res.ok) {
    throw new ApiError(res.status, await extractError(res));
  }

  if (res.status === 204) return undefined as T;
  // Some 200s carry a genuinely empty body (e.g. GET /billing/subscription
  // when the tenant has none) rather than a JSON "null" — res.json() throws
  // SyntaxError on that. Read as text first and only parse if non-empty.
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * apiFetch for Client Components: pulls the current Supabase access token from
 * the browser session and attaches it. Throws if there's no session (the
 * caller is unauthenticated — middleware should have redirected already).
 */
export async function browserApiFetch<T = unknown>(
  path: string,
  options: Omit<ApiFetchOptions, "token"> = {},
): Promise<T> {
  const { createClient } = await import("@/lib/supabase/client");
  const {
    data: { session },
  } = await createClient().auth.getSession();

  if (!session) throw new ApiError(401, "Not signed in");
  try {
    return await apiFetch<T>(path, { ...options, token: session.access_token });
  } catch (err) {
    if (isSubscriptionInactiveError(err)) notifySubscriptionInactive();
    throw err;
  }
}

async function extractError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string | string[] };
    const message = Array.isArray(data.message)
      ? data.message.join(", ")
      : data.message;
    return message ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
