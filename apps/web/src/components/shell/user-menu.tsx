"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ChevronsUpDown,
  LogOut,
  Monitor,
  Moon,
  Sun,
  Languages,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/locale";
import { writeLocaleCookie } from "@/lib/i18n/locale-cookie";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale, useTranslations } from "@/lib/i18n/provider";

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export function UserMenu({
  email,
  role,
}: {
  email: string;
  role: string | null;
}) {
  const router = useRouter();
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const { theme = "system", setTheme } = useTheme();
  // Resolved server-side from the same cookie the root layout reads, so the
  // radio group's checked state matches on first render — no hydration flip.
  const locale = useLocale();
  const initial = (email[0] ?? "?").toUpperCase();

  function changeLocale(next: Locale) {
    writeLocaleCookie(next);
    router.refresh();
  }

  async function signOut() {
    setPending(true);
    await createClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const ThemeIcon = THEME_ICONS[theme as keyof typeof THEME_ICONS] ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg border border-border p-2 text-start text-sm transition-colors hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-ink text-xs font-medium text-paper">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{email}</span>
          {role ? (
            <span className="eyebrow block text-muted-foreground">{role}</span>
          ) : null}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            {email}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ThemeIcon className="size-4" />
            {t.userMenu.theme}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={theme}
              onValueChange={(value) => setTheme(value as string)}
            >
              <DropdownMenuRadioItem value="light">
                <Sun className="size-4" />
                {t.userMenu.light}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-4" />
                {t.userMenu.dark}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <Monitor className="size-4" />
                {t.userMenu.system}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Languages className="size-4" />
            {t.userMenu.language}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={locale}
              onValueChange={(value) => changeLocale(value as Locale)}
            >
              {LOCALES.map((code) => (
                <DropdownMenuRadioItem key={code} value={code}>
                  {LOCALE_LABELS[code]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut} disabled={pending}>
          <LogOut className="size-4" />
          {t.userMenu.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
