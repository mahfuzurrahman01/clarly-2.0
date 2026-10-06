"use client";

import { useState } from "react";
import { Loader2, Pause, Play, Send, Timer, X } from "lucide-react";
import { toast } from "sonner";
import {
  CampaignRefusalError,
  cancelCampaign,
  isPaused,
  isTerminal,
  pauseCampaign,
  previewSegment,
  resumeCampaign,
  scheduleCampaign,
  type CampaignRecord,
  type CampaignRefusal,
} from "@/lib/api/campaigns";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  fill,
  formatCount,
  formatUsd,
  fromLocalInputValue,
  toLocalInputValue,
} from "./format";

type Action = "launch" | "schedule" | "pause" | "resume" | "cancel";

/**
 * The lifecycle verbs, each weighted for what it actually does.
 *
 *   launch  irreversible fan-out to thousands — a dialog carrying the live
 *           audience count and the spend ceiling, gated on typing the
 *           campaign's name. Not a one-click button.
 *   cancel  terminal, and every remaining recipient is skipped — same
 *           typed confirmation.
 *   pause   reversible and recipient-preserving — a plain confirmation.
 *   resume  can be refused by three separate gates, so it says so before it
 *           runs rather than surprising the operator with a 422.
 *   schedule a time, with "in the past means now" stated rather than implied.
 */
export function LifecycleBar({
  campaign,
  onUpdated,
  onRefusal,
}: {
  campaign: CampaignRecord;
  onUpdated: (campaign: CampaignRecord) => void;
  onRefusal: (refusal: CampaignRefusal | null) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const [sendAt, setSendAt] = useState(() =>
    toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)),
  );
  const [audienceCount, setAudienceCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  const canLaunch = campaign.status === "draft";
  const canPause =
    campaign.status === "sending" || campaign.status === "scheduled";
  const canResume = isPaused(campaign.status);
  const canCancel = !isTerminal(campaign.status);

  function open(next: Action) {
    onRefusal(null);
    setTyped("");
    setAction(next);
    if (next === "launch") void countAudience();
  }

  async function countAudience() {
    setCounting(true);
    try {
      const result = await previewSegment(campaign.segmentId);
      setAudienceCount(result.count);
    } catch {
      // A failed count must not block the dialog: the server counts again at
      // schedule, and that count is the one that matters.
      setAudienceCount(null);
    } finally {
      setCounting(false);
    }
  }

  async function run(next: Action) {
    setBusy(true);
    onRefusal(null);
    try {
      const updated =
        next === "launch"
          ? await scheduleCampaign(campaign.id, null)
          : next === "schedule"
            ? await scheduleCampaign(campaign.id, fromLocalInputValue(sendAt))
            : next === "pause"
              ? await pauseCampaign(campaign.id)
              : next === "resume"
                ? await resumeCampaign(campaign.id)
                : await cancelCampaign(campaign.id);

      onUpdated(updated);
      setAction(null);
      toast.success(
        next === "launch"
          ? t.campaigns.lifecycle.launched
          : next === "schedule"
            ? t.campaigns.lifecycle.scheduled
            : next === "pause"
              ? t.campaigns.lifecycle.paused
              : next === "resume"
                ? t.campaigns.lifecycle.resumed
                : t.campaigns.lifecycle.canceled,
      );
    } catch (err) {
      if (err instanceof CampaignRefusalError) {
        // A refusal is not a toast: it has a fix, and the fix needs room.
        onRefusal(err.refusal);
        setAction(null);
      } else {
        toast.error(apiErrorMessage(err, t, t.campaigns.compose.couldNotSave));
      }
    } finally {
      setBusy(false);
    }
  }

  const nameConfirmed = typed.trim() === campaign.name.trim();

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canLaunch ? (
          <>
            <Button onClick={() => open("launch")}>
              <Send data-icon="inline-start" />
              {t.campaigns.lifecycle.launch}
            </Button>
            <Button variant="outline" onClick={() => open("schedule")}>
              <Timer data-icon="inline-start" />
              {t.campaigns.lifecycle.schedule}
            </Button>
          </>
        ) : null}

        {canResume ? (
          <Button onClick={() => open("resume")}>
            <Play data-icon="inline-start" />
            {t.campaigns.lifecycle.resume}
          </Button>
        ) : null}

        {canPause ? (
          <Button variant="outline" onClick={() => open("pause")}>
            <Pause data-icon="inline-start" />
            {t.campaigns.lifecycle.pause}
          </Button>
        ) : null}

        {canCancel ? (
          <Button variant="ghost" className="text-destructive" onClick={() => open("cancel")}>
            <X data-icon="inline-start" />
            {t.campaigns.lifecycle.cancel}
          </Button>
        ) : null}
      </div>

      {/* Launch — typed confirmation, live audience count, spend ceiling. */}
      <Dialog
        open={action === "launch"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {fill(t.campaigns.lifecycle.launchTitle, {
                count: counting
                  ? "…"
                  : audienceCount === null
                    ? "—"
                    : formatCount(audienceCount, locale),
              })}
            </DialogTitle>
            <DialogDescription>
              {fill(t.campaigns.lifecycle.launchBody, {
                number: campaign.phoneNumberId,
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg bg-secondary px-3 py-2">
            <p className="eyebrow text-muted-foreground">
              {t.campaigns.detail.spendCap}
            </p>
            <p className="mt-0.5 font-display text-xl tabular-nums">
              {formatUsd(campaign.spendCapUsd, locale)}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t.campaigns.lifecycle.launchEstimateNote}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="launch-confirm">
              {t.campaigns.lifecycle.launchConfirmLabel}
            </Label>
            <Input
              id="launch-confirm"
              value={typed}
              autoComplete="off"
              placeholder={campaign.name}
              onChange={(event) => setTyped(event.target.value)}
            />
            {typed.length > 0 && !nameConfirmed ? (
              <p className="text-xs text-destructive">
                {t.campaigns.lifecycle.nameMismatch}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button disabled={!nameConfirmed || busy} onClick={() => run("launch")}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {busy
                ? t.campaigns.lifecycle.working
                : t.campaigns.lifecycle.launchConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Schedule */}
      <Dialog
        open={action === "schedule"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.campaigns.lifecycle.scheduleTitle}</DialogTitle>
            <DialogDescription>
              {t.campaigns.lifecycle.scheduleHint}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="schedule-at">
              {t.campaigns.lifecycle.scheduleAtLabel}
            </Label>
            <Input
              id="schedule-at"
              type="datetime-local"
              value={sendAt}
              onChange={(event) => setSendAt(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button disabled={busy} onClick={() => run("schedule")}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.lifecycle.scheduleConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pause — reversible, so a plain confirmation. */}
      <Dialog
        open={action === "pause"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.campaigns.lifecycle.pauseTitle}</DialogTitle>
            <DialogDescription>
              {t.campaigns.lifecycle.pauseBody}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button disabled={busy} onClick={() => run("pause")}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.lifecycle.pauseConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Resume — names the three gates it has to clear first. */}
      <Dialog
        open={action === "resume"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.campaigns.lifecycle.resumeTitle}</DialogTitle>
            <DialogDescription>
              {t.campaigns.lifecycle.resumeBody}
            </DialogDescription>
          </DialogHeader>
          {campaign.status === "paused_eligibility" ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {t.campaigns.paused.eligibilityFix}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button disabled={busy} onClick={() => run("resume")}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.lifecycle.resumeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel — terminal. Typed confirmation, same weight as launch. */}
      <Dialog
        open={action === "cancel"}
        onOpenChange={(next) => {
          if (!next) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.campaigns.lifecycle.cancelTitle}</DialogTitle>
            <DialogDescription>
              {t.campaigns.lifecycle.cancelBody}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="cancel-confirm">
              {t.campaigns.lifecycle.cancelConfirmLabel}
            </Label>
            <Input
              id="cancel-confirm"
              value={typed}
              autoComplete="off"
              placeholder={campaign.name}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAction(null)}>
              {t.campaigns.compose.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={!nameConfirmed || busy}
              onClick={() => run("cancel")}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t.campaigns.lifecycle.cancelConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
