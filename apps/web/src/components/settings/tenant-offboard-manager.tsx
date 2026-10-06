"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, Trash2, Undo2 } from "lucide-react";
import {
  closeTenant,
  reopenTenant,
  type TenantClosureRecord,
} from "@/lib/api/onboarding";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

/** An open workspace reads as "no purge deadline", not as a crash. */
function formatPurgeDate(purgeAfter: string | null): string {
  if (!purgeAfter) return "the end of the grace period";
  return new Date(purgeAfter).toLocaleDateString();
}

type TenantOffboardManagerProps = {
  initialClosure: TenantClosureRecord | null;
};

export function TenantOffboardManager({
  initialClosure,
}: TenantOffboardManagerProps) {
  const t = useTranslations();
  const [closure, setClosure] = useState<TenantClosureRecord | null>(initialClosure);
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [step, setStep] = useState<"idle" | "confirm" | "closing">("idle");

  const isClosed = !!closure?.closedAt;

  async function handleClose() {
    if (step !== "confirm") {
      setStep("confirm");
      return;
    }

    setLoading(true);
    setStep("closing");
    try {
      const result = await closeTenant();
      setClosure(result);
      toast.success("Workspace closed", {
        description: `Data will be erased after ${formatPurgeDate(result.purgeAfter)}.`,
      });
      setConfirmText("");
    } catch (err) {
      toast.error(apiErrorMessage(err, t, "Failed to close workspace"));
      setStep("confirm");
    } finally {
      setLoading(false);
    }
  }

  async function handleReopen() {
    setLoading(true);
    try {
      const result = await reopenTenant();
      setClosure(result);
      toast.success("Workspace reopened");
    } catch (err) {
      toast.error(apiErrorMessage(err, t, "Failed to reopen workspace"));
    } finally {
      setLoading(false);
    }
  }

  if (isClosed) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/20">
        <div className="flex items-start gap-3">
          <AlertTriangle className="size-5 text-red-600 dark:text-red-400 mt-0.5" />
          <div className="space-y-4 flex-1">
            <div>
              <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                Workspace is closed
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-400">
                All data will be permanently erased on{" "}
                <span className="font-medium">
                  {formatPurgeDate(closure?.purgeAfter ?? null)}
                </span>.
              </p>
            </div>
            <Button
              onClick={handleReopen}
              disabled={loading}
              variant="outline"
              size="sm"
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Undo2 className="size-4" />
              )}
              Reopen workspace
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border p-6">
      <div className="flex items-start gap-3">
        <AlertTriangle className="size-5 text-muted-foreground mt-0.5" />
        <div className="space-y-4 flex-1">
          <div>
            <h3 className="text-sm font-medium">Close workspace</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This immediately stops access for all team members. Your data is
              scheduled for permanent erasure after a grace period, during which
              you can reopen.
            </p>
          </div>

          {step === "confirm" ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Type <span className="font-mono font-medium">CLOSE</span> to
                confirm.
              </p>
              <div className="flex items-center gap-2">
                <Label htmlFor="confirm-close" className="sr-only">
                  Type CLOSE to confirm
                </Label>
                <Input
                  id="confirm-close"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="CLOSE"
                  className="max-w-xs"
                  autoFocus
                />
                <Button
                  onClick={handleClose}
                  disabled={confirmText !== "CLOSE" || loading}
                  variant="destructive"
                  size="sm"
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  Close workspace
                </Button>
                <Button
                  onClick={() => {
                    setStep("idle");
                    setConfirmText("");
                  }}
                  variant="ghost"
                  size="sm"
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={handleClose}
              disabled={loading}
              variant="destructive"
              size="sm"
            >
              <Trash2 className="size-4" />
              Close workspace
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
