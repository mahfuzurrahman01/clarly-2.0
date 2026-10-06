import { cn } from "./cn";

/**
 * Indeterminate progress. Decorative by default — the surrounding control
 * carries `aria-busy`, so announcing this too would double up.
 */
export function Spinner({
  size = 16,
  label,
  className,
}: {
  size?: number;
  /** Provide only when the spinner is the sole indication of activity. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      role={label ? "status" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("animate-spin text-current", className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
