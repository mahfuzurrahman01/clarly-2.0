import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuraPage } from "@/components/marketing/aura/aura-page";
import s from "@/components/marketing/aura/aura.module.css";
import { Button } from "@/components/ui/button";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { cn } from "@/lib/utils";

/**
 * Root 404 — catches any URL that doesn't match a route anywhere in the
 * app, including inside (app)/(auth). Route-scoped not-found.tsx files
 * (e.g. inbox/[id]/not-found.tsx) take precedence within their segment;
 * this is the fallback everywhere else.
 */
export default async function RootNotFound() {
  const t = getDictionary(await getLocale());

  return (
    <AuraPage t={t} glows={["center"]} mainClassName="flex items-center justify-center px-6 py-20">
      <div className="mx-auto flex w-full max-w-lg flex-col items-center text-center">
        <p className={cn(s.giant, s.rise)} aria-hidden>
          404
        </p>
        <h1 className={cn(s.title, s.titleSm, s.rise, "mt-2")} style={{ "--i": 1 } as React.CSSProperties}>
          {t.notFound.title}
        </h1>
        <p className={cn(s.lede, s.rise, "mt-4")} style={{ "--i": 2 } as React.CSSProperties}>
          {t.notFound.body}
        </p>
        <Button
          render={<Link href="/" />}
          size="lg"
          className={cn(s.rise, "mt-9 h-11 px-5")}
          style={{ "--i": 3 } as React.CSSProperties}
        >
          <ArrowLeft className="size-4 rtl:-scale-x-100" aria-hidden />
          {t.notFound.backHome}
        </Button>
      </div>
    </AuraPage>
  );
}
