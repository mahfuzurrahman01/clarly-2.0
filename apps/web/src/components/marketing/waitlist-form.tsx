"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { CircleCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/auth/field";
import { cn } from "@/lib/utils";

// Web3Forms' free plan only accepts browser-side submissions, so this posts
// straight from the client — the access key is public by design.
const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";

type FormValues = { name: string; email: string; business?: string };

type Web3FormsResponse = { success: boolean; message?: string };

/** `className` restyles the outer card (both the form and the success state). */
export function WaitlistForm({ accessKey, className }: { accessKey: string; className?: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [joined, setJoined] = useState(false);
  // Honeypot: real users never see or fill it; Web3Forms drops submissions
  // where `botcheck` is set.
  const [botcheck, setBotcheck] = useState(false);
  const t = useTranslations();

  const schema = z.object({
    name: z.string().trim().min(1, t.landing.waitlistInvalidName).max(120),
    email: z.string().trim().email(t.landing.waitlistInvalidEmail),
    business: z.string().trim().max(160).optional(),
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    setSubmitting(true);
    try {
      const res = await fetch(WEB3FORMS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          access_key: accessKey,
          subject: `Waitlist signup: ${values.email}`,
          from_name: "Clarly waitlist",
          name: values.name,
          email: values.email,
          business: values.business || undefined,
          botcheck,
        }),
      });
      const data = (await res.json()) as Web3FormsResponse;
      if (!res.ok || !data.success) {
        toast.error(t.landing.waitlistErrorTitle, { description: data.message });
        return;
      }
      setJoined(true);
    } catch {
      toast.error(t.landing.waitlistErrorTitle, { description: t.common.networkError });
    } finally {
      setSubmitting(false);
    }
  }

  if (joined) {
    return (
      <div role="status" className={cn("space-y-3 rounded-2xl border border-border bg-card p-8", className)}>
        <CircleCheck className="size-6" />
        <h3 className="font-display text-2xl font-medium tracking-tight">
          {t.landing.waitlistSuccessTitle}
        </h3>
        <p className="text-muted-foreground">{t.landing.waitlistSuccessBody}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className={cn("space-y-5 rounded-2xl border border-border bg-card p-8", className)}
      noValidate
    >
      <Field id="waitlist-name" label={t.landing.waitlistName} error={errors.name?.message}>
        <Input id="waitlist-name" autoComplete="name" {...register("name")} />
      </Field>
      <Field id="waitlist-email" label={t.landing.waitlistEmail} error={errors.email?.message}>
        <Input
          id="waitlist-email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          {...register("email")}
        />
      </Field>
      <Field
        id="waitlist-business"
        label={t.landing.waitlistBusiness}
        hint={t.landing.waitlistOptional}
        error={errors.business?.message}
      >
        <Input id="waitlist-business" autoComplete="organization" {...register("business")} />
      </Field>
      <input
        type="checkbox"
        name="botcheck"
        className="hidden"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        checked={botcheck}
        onChange={(e) => setBotcheck(e.target.checked)}
      />
      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
        {t.landing.waitlistSubmit}
      </Button>
    </form>
  );
}
