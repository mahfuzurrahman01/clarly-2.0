import Link from "next/link";
import { AuthHeader } from "@/components/auth/auth-header";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage() {
  const t = getDictionary(await getLocale());
  return (
    <>
      <AuthHeader
        title={t.auth.forgotPassword.title}
        subtitle={
          <>
            {t.auth.forgotPassword.rememberedIt}
            <Link
              href="/login"
              className="text-foreground underline underline-offset-4"
            >
              {t.auth.forgotPassword.backToSignIn}
            </Link>
          </>
        }
      />
      <ForgotPasswordForm />
    </>
  );
}
