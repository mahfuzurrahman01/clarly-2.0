import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LandingAction } from "@/components/marketing/landing/landing-action";
import { cn } from "@/lib/utils";
import { Reveal } from "./reveal";
import { Spotlight } from "./spotlight";
import s from "./aura.module.css";

/** Closing call to action for public pages: a lit glass panel with one primary action. */
export function CtaBand({ title, body, action }: { title: string; body: string; action: LandingAction }) {
  return (
    <section className="mx-auto w-full max-w-6xl px-6 pb-24 sm:pb-32">
      <Reveal>
        <Spotlight className="relative overflow-hidden px-8 py-14 text-center sm:px-14 sm:py-20">
          <div aria-hidden className={cn(s.glow, s.glowCenter)} />
          <h2 className={cn(s.title, s.titleSm, "relative mx-auto max-w-2xl")}>{title}</h2>
          <p className={cn(s.lede, "relative mx-auto mt-5")}>{body}</p>
          <Button render={<Link href={action.href} />} size="lg" className="relative mt-9 h-11 px-6">
            {action.label}
            <ArrowRight className="size-4 rtl:-scale-x-100" aria-hidden />
          </Button>
        </Spotlight>
      </Reveal>
    </section>
  );
}
