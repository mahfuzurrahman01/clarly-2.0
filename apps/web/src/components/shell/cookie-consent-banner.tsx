"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "clarly-cookie-consent";
type Consent = "accepted" | "declined";

function readConsent(): Consent | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "accepted" || value === "declined" ? value : null;
  } catch {
    // Private browsing / blocked storage — treat as "no decision yet" and
    // just keep re-showing the banner rather than failing the render.
    return null;
  }
}

function writeConsent(value: Consent): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Best-effort persistence; the banner still closes for this session.
  }
}

/**
 * Gated by NEXT_PUBLIC_COOKIE_CONSENT_ENABLED (see lib/env.ts) — only
 * rendered by the caller when that flag is on, i.e. once analytics/EU
 * traffic tooling actually needs consent. Persists the visitor's choice in
 * localStorage so it doesn't re-prompt every visit.
 */
export function CookieConsentBanner() {
  const t = useTranslations();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => {
      if (readConsent() === null) setVisible(true);
    }, 0);
    return () => clearTimeout(id);
  }, []);

  function decide(value: Consent) {
    writeConsent(value);
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label={t.cookieConsent.body}
      className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-3 px-6 py-4 text-sm text-muted-foreground sm:flex-row sm:justify-between">
        <p>
          {t.cookieConsent.body}{" "}
          <Link href="/legal/privacy" className="underline hover:text-foreground">
            {t.cookieConsent.privacyLink}
          </Link>
          .
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => decide("declined")}>
            {t.cookieConsent.decline}
          </Button>
          <Button size="sm" onClick={() => decide("accepted")}>
            {t.cookieConsent.accept}
          </Button>
        </div>
      </div>
    </div>
  );
}
