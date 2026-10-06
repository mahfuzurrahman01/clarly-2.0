"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, SETTINGS_CHILDREN } from "@/lib/nav";
import { useTranslations } from "@/lib/i18n/provider";

export function NavLinks({
  role,
  onNavigate,
}: {
  role?: string | null;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const isAdmin = role === "admin";
  const t = useTranslations();
  const inSettings = pathname.startsWith("/settings");
  const [settingsOpen, setSettingsOpen] = useState(inSettings);

  return (
    <nav className="flex flex-col gap-6">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((i) => !i.adminOnly || isAdmin);
        if (items.length === 0) return null;
        return (
        <div key={group.id} className="flex flex-col gap-1">
          <p className="eyebrow px-3 pb-1 text-muted-foreground/70">
            {t.nav.groups[group.id]}
          </p>
          {items.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;

            if (!item.ready) {
              return (
                <span
                  key={item.href}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground/50"
                  aria-disabled
                >
                  <Icon className="size-4" />
                  {t.nav.items[item.id]}
                  <span className="eyebrow ms-auto text-muted-foreground/40">
                    {t.nav.soon}
                  </span>
                </span>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-lime-soft/70 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-lime-soft/40 hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {t.nav.items[item.id]}
              </Link>
            );
          })}
        </div>
        );
      })}

      {/* Workspace / Settings — a collapsible group so each section (Agent,
          Knowledge base, Team) is reachable directly, without landing on a
          shared tabbed Settings page first. Admin-only, mirroring the
          backend's 403 on these routes for the agent role. */}
      {isAdmin ? (
        <div className="flex flex-col gap-1">
          <p className="eyebrow px-3 pb-1 text-muted-foreground/70">
            {t.nav.groups.workspace}
          </p>
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            aria-expanded={settingsOpen}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              inSettings
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:bg-lime-soft/40 hover:text-foreground",
            )}
          >
            <Settings className="size-4" />
            {t.settings.title}
            {settingsOpen ? (
              <ChevronDown className="ms-auto size-4" />
            ) : (
              <ChevronRight className="ms-auto size-4 rtl:-scale-x-100" />
            )}
          </button>
          {settingsOpen ? (
            <div className="ms-3 flex flex-col gap-1 border-s border-border ps-3">
              {SETTINGS_CHILDREN.map((child) => {
                const active =
                  pathname === child.href || pathname.startsWith(`${child.href}/`);
                const ChildIcon = child.icon;
                return (
                  <Link
                    key={child.href}
                    href={child.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-lime-soft/70 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-lime-soft/40 hover:text-foreground",
                    )}
                  >
                    <ChildIcon className="size-4" />
                    {t.nav.items[child.id]}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
