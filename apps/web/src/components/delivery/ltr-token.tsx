import { cn } from "@/lib/utils";

/**
 * A left-to-right token sitting inside right-to-left copy: a tracking number,
 * a courier brand name, an account reference, a callback URL.
 *
 * `dir="ltr"` on an element also makes it a bidi isolate (the UA stylesheet's
 * `[dir] { unicode-bidi: isolate }`), which is the part that matters — without
 * isolation a trailing punctuation mark or a digit run reorders itself into
 * the surrounding Arabic sentence and the number reads wrong. Never style a
 * tracking number with a plain `<span>`.
 */
export function LtrToken({
  children,
  className,
  tabular = false,
}: {
  children: React.ReactNode;
  className?: string;
  /** Lines digits up across rows. Use for tracking numbers and references. */
  tabular?: boolean;
}) {
  return (
    <span
      dir="ltr"
      className={cn(
        "inline-block text-start",
        tabular && "[font-variant-numeric:tabular-nums]",
        className,
      )}
    >
      {children}
    </span>
  );
}
