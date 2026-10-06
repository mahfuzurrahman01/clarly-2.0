import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, letting a caller's utility beat the component's default
 * for the same property. Without the merge step `className="px-6"` and a
 * built-in `px-3` both land and the winner is stylesheet order, not intent.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
