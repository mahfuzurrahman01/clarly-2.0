import { getConsoleSession } from "@/lib/session";
import { getSubscription } from "@/lib/api/billing";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getConsoleSession();
  // Best-effort: a workspace with billing not yet configured (or a
  // momentary API hiccup) shouldn't block the whole console from rendering
  // — the trial badge just stays hidden, same as "no subscription" (null).
  const subscription = await getSubscription(session.token).catch(() => null);

  return (
    <AppShell
      tenantName={session.tenant.name}
      email={session.email}
      role={session.role}
      subscription={subscription}
    >
      {children}
    </AppShell>
  );
}
