"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

export default function BillingSettingsError({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-border p-8">
      <h2 className="font-display text-xl font-medium tracking-tight">
        {t.billing.errorTitle}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t.billing.errorBody} {t.common.temporary}
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        <RefreshCw className="size-4" />
        {t.common.tryAgain}
      </Button>
    </div>
  );
}
