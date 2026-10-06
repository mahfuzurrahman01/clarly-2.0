"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/locale";
import { writeLocaleCookie } from "@/lib/i18n/locale-cookie";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * One-tap language toggle for public pages. With two locales a toggle beats a
 * menu: it shows the language you'd switch *to*, written in that language.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const next: Locale = LOCALES.find((l) => l !== locale) ?? locale;

  function switchLocale() {
    writeLocaleCookie(next);
    startTransition(() => router.refresh());
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={switchLocale}
      disabled={pending}
      aria-label={t.common.changeLanguage}
      lang={next}
      className={cn("gap-1.5", className)}
    >
      <Languages className="size-3.5" aria-hidden />
      {LOCALE_LABELS[next]}
    </Button>
  );
}
