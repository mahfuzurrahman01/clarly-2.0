import { Suspense } from "react";
import Link from "next/link";
import { AuthHeader } from "@/components/auth/auth-header";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const t = getDictionary(await getLocale());
  return (
    <>
      <AuthHeader
        title={t.auth.login.title}
        subtitle={
          <>
            {t.auth.login.newToClarly}
            <Link
              href="/signup"
              className="text-foreground underline underline-offset-4"
            >
              {t.auth.login.createAccount}
            </Link>
          </>
        }
      />
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  );
}
