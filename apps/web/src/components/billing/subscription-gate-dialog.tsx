"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { onSubscriptionInactive } from "@/lib/api/client";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";

/**
 * Global upgrade prompt for the 403 "Subscription is not active" guard
 * (`EntitlementGuard`, apps/api). Mounted once in the app shell — every
 * gated write anywhere in the console routes through `browserApiFetch`,
 * which notifies this via `onSubscriptionInactive` instead of leaving each
 * call site to show a generic error toast.
 */
export function SubscriptionGateDialog() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  useEffect(() => onSubscriptionInactive(() => setOpen(true)), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.billing.upgradeDialogTitle}</DialogTitle>
          <DialogDescription>{t.billing.upgradeDialogBody}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t.billing.upgradeDialogDismiss}
          </DialogClose>
          <Button render={<Link href="/settings/billing" />} onClick={() => setOpen(false)}>
            {t.billing.upgradeDialogCta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
