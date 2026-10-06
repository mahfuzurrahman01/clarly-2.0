import type { ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";

/**
 * An empty state is a screen, not a sentence. Every one of these carries a
 * reason it is empty and the single action that fills it — "No items found"
 * tells the user nothing they had not already worked out.
 */
export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-panel border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? <div className="text-ink-faint">{icon}</div> : null}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-ink-muted">{body}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/**
 * Failure with a way out. Every error surface offers retry — a dead end with
 * no affordance forces a full page reload and loses whatever else was loaded.
 */
export function ErrorState({
  title = "That did not load",
  body,
  onRetry,
  className,
}: {
  title?: string;
  body?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-panel border border-danger/40 bg-danger-soft px-6 py-10 text-center",
        className,
      )}
    >
      <div className="space-y-1.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="mx-auto max-w-sm text-sm text-ink-muted">
          {body ?? "Something went wrong on our side."}
        </p>
      </div>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Enforces the one ordering that is always correct: error, then loading, then
 * empty, then content.
 *
 * Getting this order wrong is how a failed request renders as a confident
 * "nothing here" — the screen tells the user their knowledge base is fine
 * when in fact the call 500'd. Making the correct order the default removes
 * the chance to write it the other way round.
 */
export function Async<T>({
  pending,
  error,
  data,
  isEmpty,
  onRetry,
  skeleton,
  empty,
  errorTitle,
  children,
}: {
  pending: boolean;
  error?: { message?: string } | null;
  data: T | undefined;
  /** Defaults to treating an empty array as empty. */
  isEmpty?: (data: T) => boolean;
  onRetry?: () => void;
  skeleton: ReactNode;
  empty: ReactNode;
  errorTitle?: string;
  children: (data: T) => ReactNode;
}) {
  if (error) {
    return (
      <ErrorState title={errorTitle} body={error.message} onRetry={onRetry} />
    );
  }

  if (pending || data === undefined) return <>{skeleton}</>;

  const empties = isEmpty
    ? isEmpty(data)
    : Array.isArray(data) && data.length === 0;

  if (empties) return <>{empty}</>;

  return <>{children(data)}</>;
}
