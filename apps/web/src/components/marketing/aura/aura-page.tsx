import type { ComponentProps, ReactNode } from "react";
import { MarketingFooter, MarketingHeader } from "@/components/marketing/marketing-chrome";
import type { Dictionary } from "@/lib/i18n/get-dictionary";
import { cn } from "@/lib/utils";
import { AuraSky } from "./aura-sky";
import s from "./aura.module.css";

/**
 * Page frame for every public page other than the landing story: the sky
 * behind everything, the marketing header and footer around the content.
 */
export function AuraPage({
  t,
  glows,
  cta,
  mainClassName,
  children,
}: {
  t: Dictionary;
  glows?: ComponentProps<typeof AuraSky>["glows"];
  cta?: ComponentProps<typeof MarketingHeader>["cta"];
  mainClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(s.surface, "flex min-h-svh flex-col")}>
      <AuraSky glows={glows} />
      <MarketingHeader t={t} cta={cta} />
      <main className={cn("relative flex-1", mainClassName)}>{children}</main>
      <MarketingFooter t={t} />
    </div>
  );
}
