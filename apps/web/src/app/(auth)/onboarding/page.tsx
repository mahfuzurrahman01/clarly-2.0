"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { provisionTenant } from "@/lib/api/onboarding";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/auth/field";

/**
 * Finish-setup step for an authenticated user who has no tenant yet — the
 * email-confirmation signup path lands here (confirmation delays the session,
 * so the signup form couldn't provision then). Also the loop-breaker: a
 * tenant-less user bounced here by getConsoleSession can actually resolve the
 * state instead of ping-ponging between /home and /login.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const t = useTranslations();
  const [checking, setChecking] = useState(true);
  const [workspaceName, setWorkspaceName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Resolve where this user actually belongs: no session → login; already has
  // a tenant → home; otherwise stay and collect a workspace name.
  useEffect(() => {
    let alive = true;
    (async () => {
      const {
        data: { session },
      } = await createClient().auth.getSession();
      if (!alive) return;
      if (!session) {
        router.replace("/login");
        return;
      }
      // GET /onboarding/tenant sits behind auth middleware that requires
      // tenant_id to even parse the token — a tenant-less user gets 401
      // there, not 404, so that status code can't be used to decide this.
      // Check the claim already in hand instead of calling the API.
      if (session.user.app_metadata?.tenant_id) {
        router.replace("/home"); // already provisioned
      } else {
        setChecking(false); // needs provisioning — show the form
      }
    })();
    return () => {
      alive = false;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = workspaceName.trim();
    if (!name || submitting) return;
    setSubmitting(true);
    const supabase = createClient();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      await provisionTenant(session.access_token, name);
      // New claims (tenant_id/app_role) only land after a refresh.
      await supabase.auth.refreshSession();
      router.replace("/home");
      router.refresh();
    } catch (err) {
      // 409 = already provisioned (double submit / race) — just go in.
      if (err instanceof ApiError && err.status === 409) {
        await supabase.auth.refreshSession();
        router.replace("/home");
        return;
      }
      toast.error(t.auth.onboarding.errorTitle, {
        description: apiErrorMessage(err, t, t.auth.onboarding.tryAgain),
      });
      setSubmitting(false);
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login");
  }

  if (checking) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t.auth.onboarding.finishingSignIn}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="font-display text-2xl font-medium tracking-tight">
          {t.auth.onboarding.title}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t.auth.onboarding.subtitle}
        </p>
      </div>
      <form onSubmit={submit} className="space-y-5" noValidate>
        <Field id="workspaceName" label={t.auth.onboarding.workspaceName} hint={t.auth.onboarding.workspaceHint}>
          <Input
            id="workspaceName"
            autoFocus
            autoComplete="organization"
            placeholder={t.auth.onboarding.workspacePlaceholder}
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
          />
        </Field>
        <Button type="submit" className="w-full" size="lg" disabled={submitting || !workspaceName.trim()}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          {t.auth.onboarding.createWorkspace}
        </Button>
      </form>
      <button
        type="button"
        onClick={signOut}
        className="text-xs text-muted-foreground underline hover:text-foreground"
      >
        {t.auth.onboarding.signOut}
      </button>
    </div>
  );
}
