import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import s from "./aura.module.css";

const rise = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * Eyebrow, display title and lede with the landing page's entrance (each line
 * rises in turn). `children` sit underneath — usually the page's actions.
 */
export function PageHero({
  eyebrow,
  title,
  lede,
  size = "lg",
  align = "start",
  className,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  size?: "lg" | "sm";
  align?: "start" | "center";
  className?: string;
  children?: ReactNode;
}) {
  const center = align === "center";
  return (
    <div className={cn(center && "mx-auto text-center", className)}>
      <p className={cn("eyebrow", s.eyebrow, s.rise)} style={rise(0)}>
        {eyebrow}
      </p>
      <h1 className={cn(s.title, size === "sm" && s.titleSm, s.rise, "mt-5")} style={rise(1)}>
        {title}
      </h1>
      {lede ? (
        <p className={cn(s.lede, s.rise, "mt-6", center && "mx-auto")} style={rise(2)}>
          {lede}
        </p>
      ) : null}
      {children ? (
        <div className={cn(s.rise, "mt-9 flex flex-wrap items-center gap-3", center && "justify-center")} style={rise(3)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Lime italic emphasis for a word or phrase inside a PageHero title. */
export function Em({ children }: { children: ReactNode }) {
  return <em className={s.em}>{children}</em>;
}
