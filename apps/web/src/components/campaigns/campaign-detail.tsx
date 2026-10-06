"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Pencil } from "lucide-react";
import {
  getCampaignStats,
  isPaused,
  type CampaignRecord,
  type CampaignRecipient,
  type CampaignRefusal,
  type CampaignStats,
} from "@/lib/api/campaigns";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { CampaignRecipients } from "./campaign-recipients";
import { CampaignStatsPanel } from "./campaign-stats-panel";
import { CampaignStatusChip } from "./campaign-status-chip";
import { formatDateTime, formatUsd } from "./format";
import { LifecycleBar } from "./lifecycle-bar";
import { PauseExplainer } from "./pause-explainer";
import { RefusalPanel } from "./refusal-panel";

/**
 * One campaign: what it is, what state it is in and why, what it has done,
 * and the verbs that still apply.
 *
 * Order is deliberate — a paused campaign's explanation sits ABOVE the
 * delivery numbers, because "why did this stop" is the question an operator
 * arrives with, and the numbers cannot answer it.
 */
export function CampaignDetail({
  initialCampaign,
  initialStats,
  initialRecipients,
  segmentName,
  templateName,
}: {
  initialCampaign: CampaignRecord;
  initialStats: CampaignStats | null;
  initialRecipients: CampaignRecipient[];
  segmentName: string | null;
  templateName: string | null;
}) {
  const t = useTranslations();
  const locale = useLocale();

  const [campaign, setCampaign] = useState(initialCampaign);
  const [stats, setStats] = useState(initialStats);
  const [refusal, setRefusal] = useState<CampaignRefusal | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const launched = campaign.recipientCount > 0 || campaign.startedAt !== null;
  const Back = locale === "ar" ? ArrowRight : ArrowLeft;

  async function refreshStats() {
    setRefreshing(true);
    try {
      const next = await getCampaignStats(campaign.id);
      setStats(next);
      setStatsError(null);
    } catch (err) {
      setStatsError(apiErrorMessage(err, t, t.campaigns.stats.couldNotLoad));
    } finally {
      setRefreshing(false);
    }
  }

  function onUpdated(next: CampaignRecord) {
    setCampaign(next);
    void refreshStats();
  }

  return (
    <div className="space-y-10">
      <div className="space-y-5">
        <Button
          variant="ghost"
          size="sm"
          className="-ms-2"
          render={<Link href="/campaigns" />}
        >
          <Back data-icon="inline-start" />
          {t.campaigns.detail.back}
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-6">
          <div className="space-y-2">
            <CampaignStatusChip status={campaign.status} size="lg" />
            <h1 className="font-display text-3xl font-medium tracking-tight">
              {campaign.name}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {campaign.status === "draft" ? (
              <Button
                variant="outline"
                render={<Link href={`/campaigns/${campaign.id}/edit`} />}
              >
                <Pencil data-icon="inline-start" />
                {t.campaigns.detail.edit}
              </Button>
            ) : null}
            <LifecycleBar
              campaign={campaign}
              onUpdated={onUpdated}
              onRefusal={setRefusal}
            />
          </div>
        </div>
      </div>

      {refusal ? (
        <RefusalPanel refusal={refusal} onDismiss={() => setRefusal(null)} />
      ) : null}

      {isPaused(campaign.status) ? (
        <PauseExplainer
          status={campaign.status}
          pauseReason={campaign.pauseReason}
          pendingCount={stats ? stats.pending : null}
        />
      ) : null}

      {campaign.status === "failed" && campaign.failureReason ? (
        <section className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
          <h2 className="font-display text-lg font-medium tracking-tight text-destructive">
            {t.campaigns.detail.failureTitle}
          </h2>
          <p className="mt-2 max-w-[65ch] text-sm text-foreground">
            {campaign.failureReason}
          </p>
        </section>
      ) : null}

      <section aria-labelledby="campaign-overview-title" className="space-y-4">
        <h2
          id="campaign-overview-title"
          className="font-display text-lg font-medium tracking-tight"
        >
          {t.campaigns.detail.overview}
        </h2>
        <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact
            label={t.campaigns.detail.template}
            value={templateName ?? campaign.templateId}
          />
          <Fact
            label={t.campaigns.detail.audience}
            value={segmentName ?? campaign.segmentId}
          />
          <Fact
            label={t.campaigns.detail.number}
            value={campaign.phoneNumberId}
            numeric
          />
          <Fact
            label={t.campaigns.detail.spendCap}
            value={formatUsd(campaign.spendCapUsd, locale)}
            numeric
          />
          {campaign.estimatedCostUsd > 0 ? (
            <Fact
              label={t.campaigns.detail.estimated}
              value={formatUsd(campaign.estimatedCostUsd, locale)}
              hint={t.campaigns.detail.estimatedNote}
              numeric
            />
          ) : null}
          {campaign.scheduledAt ? (
            <Fact
              label={t.campaigns.detail.scheduledFor}
              value={formatDateTime(campaign.scheduledAt, locale)}
            />
          ) : null}
          {campaign.startedAt ? (
            <Fact
              label={t.campaigns.detail.startedAt}
              value={formatDateTime(campaign.startedAt, locale)}
            />
          ) : null}
          {campaign.completedAt ? (
            <Fact
              label={t.campaigns.detail.completedAt}
              value={formatDateTime(campaign.completedAt, locale)}
            />
          ) : null}
          <Fact
            label={t.campaigns.detail.createdAt}
            value={formatDateTime(campaign.createdAt, locale)}
          />
        </dl>
        {campaign.status === "draft" ? (
          <p className="text-sm text-muted-foreground">
            {t.campaigns.list.draftBadge}
          </p>
        ) : null}
      </section>

      {statsError ? (
        <p role="alert" className="text-sm text-destructive">
          {statsError}
        </p>
      ) : null}

      {stats ? (
        <CampaignStatsPanel
          stats={stats}
          refreshing={refreshing}
          onRefresh={refreshStats}
        />
      ) : null}

      <CampaignRecipients
        campaignId={campaign.id}
        launched={launched}
        initial={initialRecipients}
      />
    </div>
  );
}

function Fact({
  label,
  value,
  hint,
  numeric,
}: {
  label: string;
  value: string;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <div>
      <dt className="eyebrow text-muted-foreground">{label}</dt>
      <dd
        className={
          numeric
            ? "mt-1 text-sm tabular-nums text-foreground"
            : "mt-1 text-sm text-foreground"
        }
      >
        {numeric ? <bdi>{value}</bdi> : value}
      </dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
    </div>
  );
}
