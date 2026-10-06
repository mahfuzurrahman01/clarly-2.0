"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/auth/field";
import { PasswordInput } from "@/components/auth/password-input";

type FormValues = { password: string; confirm: string };

export function ResetPasswordForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const t = useTranslations();

  const schema = z
    .object({
      password: z.string().min(8, t.auth.resetPassword.passwordMin),
      confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, {
      message: t.auth.resetPassword.passwordsDontMatch,
      path: ["confirm"],
    });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit({ password }: FormValues) {
    setSubmitting(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setSubmitting(false);
      // The recovery session can lapse while the page is open; that is an
      // expired link to the user, not a raw "Auth session missing!".
      if (isAuthSessionMissingError(error)) {
        toast.error(t.auth.resetPassword.expiredTitle, {
          description: t.auth.resetPassword.expiredBody,
        });
        router.replace("/forgot-password");
        return;
      }
      toast.error(t.auth.resetPassword.errorTitle, { description: error.message });
      return;
    }

    toast.success(t.auth.resetPassword.successTitle);
    router.replace("/home");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
      <Field id="password" label={t.auth.resetPassword.newPassword} error={errors.password?.message}>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          {...register("password")}
        />
      </Field>
      <Field
        id="confirm"
        label={t.auth.resetPassword.confirmPassword}
        error={errors.confirm?.message}
      >
        <PasswordInput
          id="confirm"
          autoComplete="new-password"
          {...register("confirm")}
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t.auth.resetPassword.updateButton}
      </Button>
    </form>
  );
}
