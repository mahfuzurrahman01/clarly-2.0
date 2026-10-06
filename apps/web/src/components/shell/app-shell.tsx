"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NavLinks } from "./nav-links";
import { UserMenu } from "./user-menu";
import { NotificationsBell } from "./notifications-bell";
import { CornerGlow } from "./corner-glow";
import { useTranslations } from "@/lib/i18n/provider";
import type { TenantSubscriptionRecord } from "@/lib/api/billing";
import { TrialStatusBadge } from "@/components/billing/trial-status-badge";
import { SubscriptionGateDialog } from "@/components/billing/subscription-gate-dialog";

type ShellProps = {
  tenantName: string;
  email: string;
  role: string | null;
  subscription: TenantSubscriptionRecord | null;
  children: React.ReactNode;
};

/** Four-point lime sparkle beside the wordmark. */
function LimeStar({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="var(--lime)"
      aria-hidden
      className={className}
    >
      <path d="M12 1.5c.5 4.9 3.6 8 8.5 8.5-4.9.5-8 3.6-8.5 8.5-.5-4.9-3.6-8-8.5-8.5 4.9-.5 8-3.6 8.5-8.5Z" />
    </svg>
  );
}

function SidebarInner({
  tenantName,
  email,
  role,
  subscription,
  onNavigate,
}: Omit<ShellProps, "children"> & { onNavigate?: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-start justify-between px-2 pt-1">
        <div>
          <Link
            href="/home"
            onClick={onNavigate}
            className="flex items-center gap-1.5 font-display text-lg font-medium tracking-tight"
          >
            {t.common.brand}
            <LimeStar className="size-4" />
          </Link>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {tenantName}
          </p>
          <TrialStatusBadge subscription={subscription} className="mt-2" />
        </div>
        <NotificationsBell />
      </div>
      <div className="flex-1 overflow-y-auto">
        <NavLinks role={role} onNavigate={onNavigate} />
      </div>
      <UserMenu email={email} role={role} />
    </div>
  );
}

export function AppShell({ tenantName, email, role, subscription, children }: ShellProps) {
  const [open, setOpen] = useState(false);
  const t = useTranslations();

  return (
    <div className="min-h-svh">
      {/* Ambient lemon-lime ribbons + dotted arcs, bottom-right of every page. */}
      <CornerGlow />

      {/* Global upgrade prompt for the "subscription is not active" 403 —
          one mount point for the whole console (shipped under the former
          launch plan; sequencing now lives in docs/GULF_PARITY_PLAN.md). */}
      <SubscriptionGateDialog />

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 start-0 z-30 hidden w-64 border-e border-border bg-background lg:block">
        <SidebarInner
          tenantName={tenantName}
          email={email}
          role={role}
          subscription={subscription}
        />
      </aside>

      {/* Mobile top bar + drawer */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger
            render={<Button variant="ghost" size="icon" aria-label={t.common.menu} />}
          >
            <Menu className="size-5" />
          </SheetTrigger>
          <SheetContent side="inline-start" className="w-72 p-0">
            <SheetTitle className="sr-only">{t.common.navigation}</SheetTitle>
            <SidebarInner
              tenantName={tenantName}
              email={email}
              role={role}
              subscription={subscription}
              onNavigate={() => setOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <Link
          href="/home"
          className="flex items-center gap-1.5 font-display text-lg font-medium tracking-tight"
        >
          {t.common.brand}
          <LimeStar className="size-4" />
        </Link>
        <TrialStatusBadge subscription={subscription} className="ms-1" />
        <div className="ms-auto">
          <NotificationsBell />
        </div>
      </header>

      <main className="relative z-10 lg:ps-64">{children}</main>
    </div>
  );
}
