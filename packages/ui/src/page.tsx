import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Standard page frame. Horizontal padding steps down on small screens rather
 * than staying at the desktop value, which on a phone leaves content in a
 * narrow gutter.
 */
export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 border-b border-border px-4 py-5 sm:px-6 lg:px-8",
        "sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1.5">{breadcrumb}</div> : null}
        {/* One h1 per page, and it is the page title — headings start at
            level 1 so the outline is navigable. */}
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export function PageBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Grouped content block. A Panel is a container, not a card — it earns its
 * border by grouping related controls, never by decorating a single value.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-panel border border-border bg-surface shadow-panel",
        className,
      )}
    >
      {title ? (
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-5">{children}</div>
      {footer ? (
        <div className="border-t border-border bg-surface-muted px-5 py-3">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-6 lg:px-8",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Segmented filter control.
 *
 * Deliberately not `role="tablist"`: a tablist promises tabpanels, and a
 * screen reader that announces "tab 1 of 3" then finds nothing to move to has
 * been lied to. These are toggle buttons over one region, so they say so.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "inline-flex gap-1 rounded-control bg-surface-muted p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1 text-xs font-medium",
              "transition-colors duration-(--dur-fast) ease-(--ease-out)",
              active
                ? "bg-surface text-ink shadow-panel"
                : "text-ink-muted hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
