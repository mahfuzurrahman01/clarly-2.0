"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { provisionTenant } from "@/lib/api/onboarding";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/auth/field";
import { PasswordInput } from "@/components/auth/password-input";

type FormValues = { workspaceName: string; email: string; password: string };

export function SignupForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const t = useTranslations();

  const schema = z.object({
    workspaceName: z.string().min(1, t.auth.signup.workspaceRequired),
    email: z.string().email(t.auth.signup.enterValidEmail),
    password: z.string().min(8, t.auth.signup.passwordMin),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit({ workspaceName, email, password }: FormValues) {
    setSubmitting(true);
    const supabase = createClient();

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) {
      setSubmitting(false);
      toast.error(t.auth.signup.errorTitle, { description: error.message });
      return;
    }

    // Email confirmation on: no session yet. Provisioning has to wait until the
    // user confirms and signs in — surface a clear next step.
    if (!data.session) {
      setSubmitting(false);
      setEmailSent(true);
      return;
    }

    // Confirmation off: we have a fresh (tenant-less) token — provision now.
    try {
      await provisionTenant(data.session.access_token, workspaceName);
    } catch (err) {
      // 409 = this user already has a tenant; treat as already-provisioned.
      if (!(err instanceof ApiError && err.status === 409)) {
        setSubmitting(false);
        toast.error(t.auth.signup.workspaceErrorTitle, {
          description: apiErrorMessage(err, t, t.auth.signup.tryAgain),
        });
        return;
      }
    }

    // The current token predates the new claims — force a refresh so the next
    // request carries tenant_id/app_role.
    await supabase.auth.refreshSession();

    router.replace("/home");
    router.refresh();
  }

  if (emailSent) {
    return (
      <div className="space-y-4">
        <div className="flex size-11 items-center justify-center rounded-full border border-border">
          <MailCheck className="size-5" />
        </div>
        <h2 className="font-display text-2xl font-medium tracking-tight">
          {t.auth.signup.checkEmailTitle}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.auth.signup.checkEmailBody}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <Field
        id="workspaceName"
        label={t.auth.signup.workspaceName}
        error={errors.workspaceName?.message}
        hint={t.auth.signup.workspaceHint}
      >
        <Input
          id="workspaceName"
          autoComplete="organization"
          placeholder={t.auth.signup.workspacePlaceholder}
          {...register("workspaceName")}
        />
      </Field>

      <Field id="email" label={t.auth.signup.email} error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register("email")}
        />
      </Field>

      <Field
        id="password"
        label={t.auth.signup.password}
        error={errors.password?.message}
        hint={t.auth.signup.passwordHint}
      >
        <PasswordInput
          id="password"
          autoComplete="new-password"
          {...register("password")}
        />
      </Field>

      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t.auth.signup.createAccountButton}
      </Button>
    </form>
  );
}
