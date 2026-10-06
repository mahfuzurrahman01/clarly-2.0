"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  type HandshakePage,
  type SocialChannel,
  type SocialChannelKind,
  type SocialHandshake,
  connectSocialPage,
} from "@/lib/api/social-channels";
import { isHandshakeExpired, socialConnectErrorCopy } from "@/lib/channels/connect-errors";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Step B of the T4 handshake: pick channels per page from the list the
 * server got from Meta. One POST per page; one handshake can connect
 * several pages within its 15 minutes.
 */
export function PagePickerDialog({
  handshake,
  connected,
  onClose,
  onConnected,
}: {
  handshake: SocialHandshake | null;
  connected: SocialChannel[];
  onClose: () => void;
  onConnected: () => void;
}) {
  const t = useTranslations();
  return (
    <Dialog open={handshake !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.channels.pickerTitle}</DialogTitle>
          <DialogDescription>{t.channels.pickerDescription}</DialogDescription>
        </DialogHeader>
        {handshake && handshake.pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.channels.pickerEmpty}</p>
        ) : null}
        {handshake && handshake.pages.length > 0 ? (
          <ul className="max-h-[60svh] space-y-3 overflow-y-auto">
            {handshake.pages.map((page) => (
              <li key={page.id}>
                <PageRow
                  // Fresh row state per handshake.
                  key={`${handshake.handshakeId}:${page.id}`}
                  handshakeId={handshake.handshakeId}
                  page={page}
                  connected={connected}
                  onConnected={onConnected}
                  onExpired={onClose}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PageRow({
  handshakeId,
  page,
  connected,
  onConnected,
  onExpired,
}: {
  handshakeId: string;
  page: HandshakePage;
  connected: SocialChannel[];
  onConnected: () => void;
  onExpired: () => void;
}) {
  const t = useTranslations();
  const hasInstagram = page.instagram !== null;
  const isConnected = (kind: SocialChannelKind, accountId: string | undefined) =>
    connected.some(
      (c) => c.channel === kind && c.channelAccountId === accountId && c.connectionState === "connected",
    );
  const messengerConnected = isConnected("messenger", page.id);
  const instagramConnected = isConnected("instagram", page.instagram?.id);

  const [messenger, setMessenger] = useState(!messengerConnected);
  const [instagram, setInstagram] = useState(hasInstagram && !instagramConnected);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const name = page.name ?? t.channels.pageUnnamed;
  const selected: SocialChannelKind[] = [
    ...(messenger ? (["messenger"] as const) : []),
    ...(instagram && hasInstagram ? (["instagram"] as const) : []),
  ];
  const igLabel = page.instagram?.username
    ? t.channels.instagramOptionTemplate.replace("{username}", page.instagram.username)
    : t.channels.kindInstagram;

  async function connect() {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      await connectSocialPage({ handshakeId, pageId: page.id, channels: selected });
      setDone(true);
      toast.success(t.channels.pageConnectedTemplate.replace("{name}", name));
      onConnected();
    } catch (err) {
      const copy = socialConnectErrorCopy(err, t);
      toast.error(copy.message, { description: copy.detail });
      if (isHandshakeExpired(err)) onExpired();
    } finally {
      setBusy(false);
    }
  }

  const groupId = `page-${page.id}`;
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3" aria-labelledby={groupId}>
      <legend id={groupId} className="sr-only">
        {name}
      </legend>
      <p className="text-sm font-medium" aria-hidden="true">
        {name}
      </p>
      <div className="flex flex-col gap-1.5 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-lime"
            checked={messenger}
            onChange={(e) => setMessenger(e.target.checked)}
            disabled={busy || done}
          />
          {t.channels.messengerOption}
          {messengerConnected ? (
            <span className="text-xs text-muted-foreground">· {t.channels.alreadyConnected}</span>
          ) : null}
        </label>
        <label className={hasInstagram ? "flex items-center gap-2" : "flex items-center gap-2 text-muted-foreground"}>
          <input
            type="checkbox"
            className="size-4 accent-lime"
            checked={instagram}
            onChange={(e) => setInstagram(e.target.checked)}
            disabled={!hasInstagram || busy || done}
            aria-describedby={hasInstagram ? undefined : `${groupId}-ig-hint`}
          />
          {igLabel}
          {instagramConnected ? (
            <span className="text-xs text-muted-foreground">· {t.channels.alreadyConnected}</span>
          ) : null}
        </label>
        {!hasInstagram ? (
          <p id={`${groupId}-ig-hint`} className="text-xs text-muted-foreground">
            {t.channels.instagramNotLinked}
          </p>
        ) : null}
      </div>
      <div className="flex justify-end">
        {done ? (
          <span className="flex items-center gap-1 text-sm text-lime-text" role="status">
            <Check className="size-4" aria-hidden="true" />
            {t.channels.alreadyConnected}
          </span>
        ) : (
          <Button size="sm" onClick={connect} disabled={selected.length === 0 || busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t.channels.connectPage}
          </Button>
        )}
      </div>
    </fieldset>
  );
}
