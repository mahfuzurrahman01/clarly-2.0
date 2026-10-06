import { getConsoleSession } from "@/lib/session";
import { getSubscription, getUsage, listPlans } from "@/lib/api/billing";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { PageHeader } from "@/components/shell/page-header";
import { BillingManager } from "@/components/settings/billing-manager";

export const dynamic = "force-dynamic";

/** Unwrap an allSettled result, swallowing failures (empty body, etc.). */
function ok<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === "fulfilled" ? r.value : null;
}

export default async function BillingSettingsPage() {
  const t = getDictionary(await getLocale());
  const session = await getConsoleSession();

  const [usageR, subscriptionR, plansR] = await Promise.allSettled([
    getUsage(session.token),
    getSubscription(session.token),
    listPlans(session.token),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t.billing.eyebrow}
        title={t.billing.title}
        description={t.billing.description}
      />
      <BillingManager
        usage={ok(usageR)}
        subscription={ok(subscriptionR)}
        plans={ok(plansR) ?? []}
        email={session.email}
      />
    </div>
  );
}
