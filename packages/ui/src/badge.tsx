import type { ReactNode } from "react";
import { cn } from "./cn";

export type BadgeTone =
  | "neutral"
  | "accent"
  | "danger"
  | "warn"
  | "info"
  | "muted";

const TONE: Record<BadgeTone, string> = {
  neutral: "border-border bg-surface-muted text-ink-muted",
  accent: "border-accent/40 bg-accent-soft text-accent-strong",
  danger: "border-danger/40 bg-danger-soft text-danger-strong",
  warn: "border-warn/40 bg-warn-soft text-warn",
  info: "border-info/40 bg-info-soft text-info",
  muted: "border-transparent bg-transparent text-ink-faint",
};

/**
 * Status marker. `icon` is not decoration — status must never be carried by
 * colour alone, so anything conveying state passes both an icon and a label.
 */
export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: BadgeTone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/** Small uppercase section label. The one place tracking is widened. */
export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-xs font-medium tracking-eyebrow text-ink-faint uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-ink-muted">
      {children}
    </kbd>
  );
}

/** Initials avatar. No image support until there is a source for one. */
export function Avatar({
  name,
  size = 28,
}: {
  name: string;
  size?: number;
}) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="inline-grid shrink-0 place-items-center rounded-full bg-surface-muted font-medium text-ink-muted"
    >
      {initials || "?"}
    </span>
  );
}
