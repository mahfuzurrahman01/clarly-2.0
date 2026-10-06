"use client";

import { cn } from "@/lib/utils";

/**
 * A two-state opt-in control. Built here rather than added to `components/ui`
 * because this is the only switch in the console today — the rest of the
 * settings surfaces use buttons and selects — and a shared primitive with one
 * caller is a guess about the second one.
 *
 * Direction-safe by construction: the thumb is pushed with a logical
 * `ms-auto`/`me-auto` rather than a physical translate, so in Arabic the "on"
 * position lands on the left without a second rule. The track colour is the
 * animated part; the thumb snaps, because the alternative is animating a
 * margin and forcing a layout pass every frame.
 */
export function OptInSwitch({
  checked,
  onCheckedChange,
  label,
  describedBy,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex h-6 w-11 shrink-0 items-center rounded-full border p-0.5 outline-none transition-colors duration-200",
        "focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        checked
          ? "border-lime-ring/60 bg-lime-soft"
          : "border-border bg-secondary",
      )}
    >
      <span
        className={cn(
          "block size-4 rounded-full bg-card shadow-sm",
          checked ? "ms-auto" : "me-auto",
        )}
      />
    </button>
  );
}
