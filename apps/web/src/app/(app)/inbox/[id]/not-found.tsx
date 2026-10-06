import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale } from "@/lib/i18n/locale";
import { getDictionary } from "@/lib/i18n/get-dictionary";
import { Button } from "@/components/ui/button";

export default async function ConversationNotFound() {
  const t = getDictionary(await getLocale());
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10 xl:px-10">
      <div className="flex flex-col items-start gap-4 rounded-xl border border-border p-8">
        <h2 className="font-display text-xl font-medium tracking-tight">
          {t.inbox.notFoundTitle}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t.inbox.notFoundBody}
        </p>
        <Button render={<Link href="/inbox" />} variant="outline" size="sm">
          <ArrowLeft className="size-4 rtl:-scale-x-100" />
          {t.inbox.backToInbox}
        </Button>
      </div>
    </div>
  );
}
