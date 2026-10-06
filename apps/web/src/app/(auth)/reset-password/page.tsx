import Link from "next/link";
import { AuthHeader } from "@/components/auth/auth-header";
import { Button } from "@/components/ui/button";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { createClient } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage() {
  const t = getDictionary(await getLocale());

  // The recovery link lands here via /auth/callback, which exchanges the
  // emailed code for a session. No session means the link was already used,
  // expired, or the page was opened directly: say so instead of showing a
  // form whose submit can only fail with "Auth session missing!".
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return <ResetLinkExpired t={t} />;
  }

  return (
    <>
      <AuthHeader
        title={t.auth.resetPassword.title}
        subtitle={t.auth.resetPassword.subtitle}
      />
      <ResetPasswordForm />
    </>
  );
}

function ResetLinkExpired({ t }: { t: ReturnType<typeof getDictionary> }) {
  return (
    <>
      <AuthHeader
        title={t.auth.resetPassword.expiredTitle}
        subtitle={t.auth.resetPassword.expiredBody}
      />
      <Button render={<Link href="/forgot-password" />} size="lg" className="w-full">
        {t.auth.resetPassword.requestNewLink}
      </Button>
    </>
  );
}
