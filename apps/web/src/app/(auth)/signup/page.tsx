import Link from "next/link";
import { AuthHeader } from "@/components/auth/auth-header";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { SignupForm } from "./signup-form";

export default async function SignupPage() {
  const t = getDictionary(await getLocale());
  return (
    <>
      <AuthHeader
        title={t.auth.signup.title}
        subtitle={
          <>
            {t.auth.signup.alreadyHaveAccount}
            <Link
              href="/login"
              className="text-foreground underline underline-offset-4"
            >
              {t.auth.signup.signIn}
            </Link>
          </>
        }
      />
      <SignupForm />
    </>
  );
}
