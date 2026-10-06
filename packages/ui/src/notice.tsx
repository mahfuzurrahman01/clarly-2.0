import type { ReactNode } from "react";
import { cn } from "./cn";

export type NoticeTone = "info" | "success" | "error" | "warn";

const TONE: Record<NoticeTone, string> = {
  info: "border-info/40 bg-info-soft text-ink",
  success: "border-accent/40 bg-accent-soft text-ink",
  error: "border-danger/40 bg-danger-soft text-ink",
  warn: "border-warn/40 bg-warn-soft text-ink",
};

/**
 * Inline message tied to the thing above or below it. For anything transient
 * or triggered by a mutation, use Toast instead — a Notice that appears and
 * disappears in place shifts the layout under the user's cursor.
 *
 * Renders a div, not a p: a Notice frequently wraps rich content, and a p
 * inside a p is invalid HTML that the browser silently re-parents, which
 * shows up later as a hydration mismatch.
 */
export function Notice({
  tone = "info",
  title,
  action,
  children,
  className,
}: {
  tone?: NoticeTone;
  title?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start justify-between gap-4 rounded-control border px-3.5 py-3 text-sm",
        TONE[tone],
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-ink-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
