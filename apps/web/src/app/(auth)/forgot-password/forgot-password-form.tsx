"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/auth/field";

type FormValues = { email: string };

export function ForgotPasswordForm() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const t = useTranslations();

  const schema = z.object({
    email: z.string().email(t.auth.forgotPassword.enterValidEmail),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit({ email }: FormValues) {
    setSubmitting(true);
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setSubmitting(false);

    if (error) {
      toast.error(t.auth.forgotPassword.errorTitle, { description: error.message });
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <div className="flex size-11 items-center justify-center rounded-full border border-border">
          <MailCheck className="size-5" />
        </div>
        <h2 className="font-display text-2xl font-medium tracking-tight">
          {t.auth.forgotPassword.checkEmailTitle}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.auth.forgotPassword.checkEmailBody}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <Field id="email" label={t.auth.forgotPassword.email} error={errors.email?.message}>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register("email")}
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t.auth.forgotPassword.sendResetLink}
      </Button>
    </form>
  );
}
