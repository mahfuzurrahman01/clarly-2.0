"use client";

import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn";

interface FieldContextValue {
  controlId: string;
  hintId?: string;
  errorId?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Controls read their ids from the surrounding Field so the wiring is automatic. */
function useFieldControl() {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: field.controlId,
    "aria-describedby":
      [field.hintId, field.errorId].filter(Boolean).join(" ") || undefined,
    "aria-invalid": field.invalid || undefined,
  };
}

/**
 * The control surface, for the rare element the primitives below do not cover.
 * Prefer Input/Textarea/Select — they also wire up the Field's ids.
 */
export const controlClasses = cn(
  "w-full rounded-control border bg-canvas px-3 text-sm text-ink",
  "border-border transition-colors duration-(--dur-fast) ease-(--ease-out)",
  "placeholder:text-ink-faint",
  "hover:border-border-strong",
  "disabled:cursor-not-allowed disabled:opacity-55",
  // The visible focus ring comes from the global :focus-visible rule. Border
  // colour alone is not a focus indicator (WCAG 2.4.11), so it is never
  // suppressed here with outline-none.
  "aria-invalid:border-danger",
  "[@media(pointer:coarse)]:min-h-11",
);

/**
 * Label + optional hint + optional error, wired to its control by id.
 *
 * The label is always rendered as visible text. Placeholder-as-label is not
 * offered: it disappears the moment the field has content, which is exactly
 * when someone reviewing their answers needs it.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const base = useId();
  const value: FieldContextValue = {
    controlId: `${base}-control`,
    hintId: hint ? `${base}-hint` : undefined,
    errorId: error ? `${base}-error` : undefined,
    invalid: Boolean(error),
  };

  return (
    <FieldContext.Provider value={value}>
      <div className={cn("flex flex-col gap-1.5", className)}>
        <label htmlFor={value.controlId} className="text-sm font-medium">
          {label}
          {required ? (
            <span aria-hidden className="ml-1 text-ink-faint">
              *
            </span>
          ) : null}
        </label>
        {hint ? (
          <p id={value.hintId} className="text-xs text-ink-muted">
            {hint}
          </p>
        ) : null}
        {children}
        {error ? (
          <p id={value.errorId} className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...useFieldControl()}
      className={cn(controlClasses, "h-9", className)}
      {...rest}
    />
  );
}

export function Textarea({
  className,
  rows = 4,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...useFieldControl()}
      rows={rows}
      className={cn(controlClasses, "resize-y py-2 leading-relaxed", className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...useFieldControl()}
      className={cn(controlClasses, "h-9 pr-8", className)}
      {...rest}
    >
      {children}
    </select>
  );
}

/**
 * Checkbox with its label as part of the hit area — a 13px label beside a
 * 16px box is two small targets where there should be one comfortable one.
 */
export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 py-1",
        rest.disabled && "cursor-not-allowed opacity-55",
        className,
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
        {...rest}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm">{label}</span>
        {hint ? <span className="text-xs text-ink-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Switch = an immediate-effect toggle. Use Checkbox inside forms that save. */
export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "inline-flex items-center gap-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-55",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-(--dur-fast) ease-(--ease-out)",
          checked ? "bg-accent" : "bg-border-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-surface shadow-panel",
            "transition-[left] duration-(--dur-fast) ease-(--ease-out)",
            checked ? "left-4.5" : "left-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}
