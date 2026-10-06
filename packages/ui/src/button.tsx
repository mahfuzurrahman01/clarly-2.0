import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  // Filled variants pair each fill with its own foreground token — never a
  // literal white, which fails contrast once the fill lightens in dark mode.
  primary:
    "bg-accent text-on-accent hover:bg-accent-strong active:bg-accent-strong",
  secondary:
    "border border-border bg-surface text-ink hover:bg-surface-muted hover:border-border-strong",
  ghost: "text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger:
    "bg-danger text-on-danger hover:bg-danger-strong active:bg-danger-strong",
};

const SIZE: Record<ButtonSize, string> = {
  // Both sizes clear the 44px touch target via min-h on coarse pointers,
  // set in the base classes below rather than per size.
  sm: "h-8 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3.5 text-sm",
};

/**
 * Button styling for elements that are not buttons.
 *
 * A navigation is an anchor — it must be middle-clickable, copyable, and
 * crawlable — so it gets the classes rather than being wrapped in a button.
 * Exported instead of an `asChild` slot: one exported function is easier to
 * reason about than cloned props landing on an unknown child.
 */
export function buttonClasses({
  variant = "secondary",
  size = "md",
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium",
    "transition-colors duration-(--dur-fast) ease-(--ease-out)",
    "[@media(pointer:coarse)]:min-h-11",
    SIZE[size],
    VARIANT[variant],
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  iconLeft,
  iconRight,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      // A loading button stays focusable but rejects activation, so the
      // keyboard user is not thrown to the top of the document mid-submit.
      aria-busy={loading || undefined}
      aria-disabled={loading || disabled || undefined}
      disabled={disabled}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-control font-medium",
        "transition-colors duration-(--dur-fast) ease-(--ease-out)",
        "disabled:pointer-events-none disabled:opacity-55",
        "aria-busy:pointer-events-none",
        "[@media(pointer:coarse)]:min-h-11",
        SIZE[size],
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner size={size === "sm" ? 14 : 16} />
        </span>
      ) : null}
      <span
        className={cn(
          "inline-flex items-center",
          size === "sm" ? "gap-1.5" : "gap-2",
          loading && "invisible",
        )}
      >
        {iconLeft}
        {children}
        {iconRight}
      </span>
    </button>
  );
}
