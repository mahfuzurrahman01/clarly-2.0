"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ClipboardList,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  SendHorizontal,
  ShieldOff,
  ThumbsDown,
  ThumbsUp,
  UserRoundCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  type ChannelKind,
  type ConversationDetail,
  type ConversationMessage,
  type FeedbackRating,
  type Page,
  clearAnswerRating,
  getMessages,
  rateAnswer,
  sendReply,
  sendTemplateMessage,
  takeOver,
  handBack,
} from "@/lib/api/inbox";
import {
  type MessageTemplateRecord,
  listTemplates,
  previewTemplate,
} from "@/lib/api/templates";
import { type CustomerConsentRecord, getConsent, setConsent } from "@/lib/api/consent";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { relativeAgo } from "@/lib/i18n/relative-time";
import { useLocale, useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { ChannelBadge } from "@/components/channels/channel-badge";
import { MediaAttachment } from "./media-attachment";
import { cn } from "@/lib/utils";
import { contactNameDir } from "@/lib/i18n/bidi";

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ThreadProps = {
  conversationId: string;
  detail: ConversationDetail;
  initialMessages: Page<ConversationMessage>;
  currentUserId: string;
  isAdmin: boolean;
  now: number;
};

export function ConversationThread({
  conversationId,
  detail: initialDetail,
  initialMessages,
  currentUserId,
  isAdmin,
}: ThreadProps) {
  const t = useTranslations();
  const locale = useLocale();
  const [detail, setDetail] = useState(initialDetail);
  // API returns newest-first; display oldest-first.
  const [messages, setMessages] = useState<ConversationMessage[]>(() =>
    [...initialMessages.items].reverse(),
  );
  const [olderCursor, setOlderCursor] = useState(initialMessages.nextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [handoverPending, setHandoverPending] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = () =>
    bottomRef.current?.scrollIntoView({ block: "end" });

  useEffect(() => {
    scrollToBottom();
    // Only on mount — later sends scroll explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heldByMe =
    detail.handoverState === "human" && detail.handoverUserId === currentUserId;
  const heldByOther =
    detail.handoverState === "human" && detail.handoverUserId !== currentUserId;
  const windowOpen = detail.replyWindow.open;

  async function loadOlder() {
    if (!olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await getMessages(conversationId, { cursor: olderCursor });
      setMessages((prev) => [...[...page.items].reverse(), ...prev]);
      setOlderCursor(page.nextCursor);
    } catch {
      toast.error(t.inbox.couldNotLoadEarlier);
    } finally {
      setLoadingOlder(false);
    }
  }

  async function onHandover(action: "take" | "return") {
    setHandoverPending(true);
    try {
      const updated =
        action === "take"
          ? await takeOver(conversationId)
          : await handBack(conversationId);
      setDetail(updated);
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t.inbox.teammateHoldingError
          : t.inbox.couldNotChangeHandover,
      );
    } finally {
      setHandoverPending(false);
    }
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;

    const clientMessageId = crypto.randomUUID();
    const optimistic: ConversationMessage = {
      id: clientMessageId,
      role: "human_agent",
      content: body,
      createdAt: new Date().toISOString(),
      deliveryStatus: "sent",
      deliveryError: null,
      authorUserId: currentUserId,
      feedback: null,
      media: null,
    };

    setMessages((prev) => [...prev, optimistic]);
    setText("");
    setSending(true);
    requestAnimationFrame(scrollToBottom);

    try {
      const res = await sendReply(conversationId, body, clientMessageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === clientMessageId
            ? {
                ...m,
                id: res.messageId,
                deliveryStatus: res.delivered ? "sent" : "failed",
                deliveryError: res.deliveryError,
              }
            : m,
        ),
      );
      // The send takes the conversation over for us.
      setDetail((d) => ({
        ...d,
        handoverState: "human",
        handoverUserId: currentUserId,
      }));
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== clientMessageId));
      setText(body);
      if (err instanceof ApiError && err.status === 409) {
        toast.error(t.inbox.replyWindowClosedError);
        setDetail((d) => ({
          ...d,
          replyWindow: { open: false, expiresAt: d.replyWindow.expiresAt },
        }));
      } else {
        toast.error(
          apiErrorMessage(err, t, t.inbox.couldNotSendReply),
        );
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col lg:h-svh">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
        <Button
          render={<Link href="/inbox" />}
          variant="ghost"
          size="icon"
          aria-label={t.inbox.backToInboxAria}
        >
          <ArrowLeft className="size-5 rtl:-scale-x-100" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1
              dir={contactNameDir(detail.customerName)}
              className="min-w-0 truncate font-medium"
            >
              {detail.customerName ?? detail.customerPhone}
            </h1>
            <ChannelBadge channel={detail.channel} />
            {detail.escalated ? (
              <span className="eyebrow rounded bg-secondary px-1.5 py-0.5 text-muted-foreground">
                {t.inbox.escalatedBadge}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            <bdi dir="ltr">{detail.customerPhone}</bdi> ·{" "}
            {t.inbox.lastMessageTemplate.replace(
              "{age}",
              relativeAgo(detail.lastInboundAt, locale),
            )}
          </p>
        </div>
        {isAdmin ? <ConsentControl phone={detail.customerPhone} /> : null}
        <Button
          render={
            <Link href={`/orders?conversationId=${conversationId}`} />
          }
          variant="ghost"
          size="icon"
          aria-label={t.inbox.viewOrdersAria}
        >
          <ClipboardList className="size-5" />
        </Button>
        <HandoverControl
          state={detail.handoverState}
          heldByMe={heldByMe}
          heldByOther={heldByOther}
          pending={handoverPending}
          onTake={() => onHandover("take")}
          onReturn={() => onHandover("return")}
        />
      </header>

      {detail.intake && detail.intake.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2 sm:px-6">
          {detail.intake.map((f) => (
            <span
              key={f.key}
              className="rounded-md bg-secondary px-2 py-0.5 text-xs"
            >
              <span className="text-muted-foreground">{f.label}:</span>{" "}
              {f.value}
            </span>
          ))}
        </div>
      ) : null}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-3">
          {olderCursor ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={loadOlder}
                disabled={loadingOlder}
              >
                {loadingOlder ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {t.inbox.loadEarlier}
              </Button>
            </div>
          ) : null}

          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              conversationId={conversationId}
              onFeedbackChange={(feedback) =>
                setMessages((prev) =>
                  prev.map((it) => (it.id === m.id ? { ...it, feedback } : it)),
                )
              }
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border px-4 py-3 sm:px-6">
        <div className="mx-auto max-w-2xl space-y-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setTemplatesOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <MessagesSquare className="size-3.5" />
              {templatesOpen ? t.inbox.hideTemplates : t.inbox.useTemplate}
            </button>
            {!windowOpen ? (
              <span className="eyebrow text-muted-foreground">
                {t.inbox.replyWindowClosedShort}
              </span>
            ) : null}
          </div>

          {templatesOpen ? (
            <TemplatePicker
              channel={detail.channel}
              onInsert={(rendered) => {
                setText(rendered);
                setTemplatesOpen(false);
              }}
              onSent={(msg) => {
                setMessages((prev) => [...prev, msg]);
                setDetail((d) => ({
                  ...d,
                  handoverState: "human",
                  handoverUserId: currentUserId,
                }));
                setTemplatesOpen(false);
                requestAnimationFrame(scrollToBottom);
              }}
              conversationId={conversationId}
            />
          ) : windowOpen ? (
            <Composer
              value={text}
              onChange={setText}
              onSend={send}
              sending={sending}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
              {t.inbox.replyWindowClosedBody}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ConsentControl({ phone }: { phone: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [record, setRecord] = useState<CustomerConsentRecord | null>(null);
  const [pending, setPending] = useState(false);

  async function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && record === null) {
      setLoading(true);
      try {
        setRecord(await getConsent(phone));
      } catch {
        toast.error(t.inbox.couldNotLoadConsent);
      } finally {
        setLoading(false);
      }
    }
  }

  async function toggle(optedOut: boolean) {
    setPending(true);
    try {
      const updated = await setConsent(phone, optedOut);
      setRecord(updated);
      toast.success(
        optedOut ? t.inbox.consentOptedOutSaved : t.inbox.consentOptedInSaved,
      );
    } catch {
      toast.error(t.inbox.couldNotSaveConsent);
    } finally {
      setPending(false);
    }
  }

  const optedOut = Boolean(record?.optedOutAt);

  return (
    <div className="relative">
      <Button
        variant={optedOut ? "destructive" : "outline"}
        size="sm"
        onClick={() => onOpenChange(!open)}
      >
        <ShieldOff className="size-3.5" />
        {optedOut ? t.inbox.consentOptedOut : t.inbox.consent}
      </Button>
      {open ? (
        <div className="absolute top-full end-0 z-20 mt-2 w-72 rounded-lg border border-border bg-popover p-3 shadow-lg">
          {loading ? (
            <div className="flex justify-center py-2">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm">
                {optedOut ? (
                  <span className="text-destructive">
                    {t.inbox.consentOptedOutBody}
                    {record?.optOutSource === "customer_keyword"
                      ? ` (${t.inbox.consentSourceKeyword})`
                      : record?.optOutSource === "admin"
                        ? ` (${t.inbox.consentSourceAdmin})`
                        : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t.inbox.consentOptedInBody}</span>
                )}
              </p>
              <Button
                size="sm"
                variant={optedOut ? "outline" : "destructive"}
                onClick={() => toggle(!optedOut)}
                disabled={pending}
                className="w-full"
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {optedOut ? t.inbox.consentAllowAgain : t.inbox.consentMarkOptedOut}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HandoverControl({
  state,
  heldByMe,
  heldByOther,
  pending,
  onTake,
  onReturn,
}: {
  state: "agent" | "human";
  heldByMe: boolean;
  heldByOther: boolean;
  pending: boolean;
  onTake: () => void;
  onReturn: () => void;
}) {
  const t = useTranslations();
  if (heldByOther) {
    return (
      <span className="eyebrow text-muted-foreground">{t.inbox.heldByTeammate}</span>
    );
  }
  if (heldByMe) {
    return (
      <Button variant="outline" size="sm" onClick={onReturn} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {t.inbox.handBackToAgent}
      </Button>
    );
  }
  // state === "agent"
  return (
    <Button variant="outline" size="sm" onClick={onTake} disabled={pending}>
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <UserRoundCheck className="size-4" />
      )}
      {t.inbox.takeOver}
    </Button>
  );
}

function MessageBubble({
  message,
  conversationId,
  onFeedbackChange,
}: {
  message: ConversationMessage;
  conversationId: string;
  onFeedbackChange: (feedback: ConversationMessage["feedback"]) => void;
}) {
  const t = useTranslations();
  const outgoing = message.role !== "user";

  return (
    <div className={cn("flex flex-col", outgoing ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          outgoing
            ? "rounded-ee-sm bg-ink text-paper"
            : "rounded-es-sm bg-muted text-foreground",
        )}
      >
        {/* `dir="auto"` + plaintext bidi: each paragraph of the message takes
            the direction of its own first strong character, so an English
            reply in the Arabic console keeps its "." and "?" at the end. */}
        <p dir="auto" className="text-start whitespace-pre-wrap [unicode-bidi:plaintext]">
          {message.content}
        </p>
      </div>

      {message.media ? (
        <div className="mt-1.5">
          <MediaAttachment
            conversationId={conversationId}
            messageId={message.id}
            media={message.media}
          />
        </div>
      ) : null}

      <div className="mt-1 flex items-center gap-2 text-[0.625rem] text-muted-foreground">
        {message.role === "human_agent" ? <span>{t.inbox.youTeam}</span> : null}
        <span className="tabular-nums">{clockTime(message.createdAt)}</span>
        {outgoing && message.deliveryStatus ? (
          <DeliveryTag
            status={message.deliveryStatus}
            error={message.deliveryError}
          />
        ) : null}
      </div>

      {message.role === "assistant" ? (
        <AnswerFeedback
          conversationId={conversationId}
          messageId={message.id}
          feedback={message.feedback}
          onChange={onFeedbackChange}
        />
      ) : null}
    </div>
  );
}

function AnswerFeedback({
  conversationId,
  messageId,
  feedback,
  onChange,
}: {
  conversationId: string;
  messageId: string;
  feedback: ConversationMessage["feedback"];
  onChange: (feedback: ConversationMessage["feedback"]) => void;
}) {
  const t = useTranslations();
  const [pending, setPending] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(feedback?.note ?? "");

  async function setRating(rating: FeedbackRating) {
    if (pending) return;
    const previous = feedback;
    if (feedback?.rating === rating) {
      onChange(null);
      setPending(true);
      try {
        await clearAnswerRating(conversationId, messageId);
        toast.success(t.inbox.ratingCleared);
      } catch {
        onChange(previous);
        toast.error(t.inbox.couldNotRate);
      } finally {
        setPending(false);
      }
      return;
    }
    onChange({ rating, note: feedback?.note ?? null });
    setPending(true);
    try {
      await rateAnswer(conversationId, messageId, rating, feedback?.note ?? undefined);
      toast.success(rating === "up" ? t.inbox.ratedGood : t.inbox.ratedBad);
    } catch {
      onChange(previous);
      toast.error(t.inbox.couldNotRate);
    } finally {
      setPending(false);
    }
  }

  async function saveNote() {
    if (!feedback || pending) return;
    setPending(true);
    try {
      await rateAnswer(conversationId, messageId, feedback.rating, note.trim() || undefined);
      onChange({ rating: feedback.rating, note: note.trim() || null });
      setNoteOpen(false);
    } catch {
      toast.error(t.inbox.couldNotRate);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={t.inbox.rateGoodAria}
          onClick={() => setRating("up")}
          disabled={pending}
          className={cn(
            "rounded-md p-1 transition-colors hover:bg-secondary",
            feedback?.rating === "up" ? "text-lime-text" : "text-muted-foreground",
          )}
        >
          <ThumbsUp className="size-3.5" fill={feedback?.rating === "up" ? "currentColor" : "none"} />
        </button>
        <button
          type="button"
          aria-label={t.inbox.rateBadAria}
          onClick={() => setRating("down")}
          disabled={pending}
          className={cn(
            "rounded-md p-1 transition-colors hover:bg-secondary",
            feedback?.rating === "down" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <ThumbsDown className="size-3.5" fill={feedback?.rating === "down" ? "currentColor" : "none"} />
        </button>
        {feedback && !noteOpen ? (
          <button
            type="button"
            onClick={() => setNoteOpen(true)}
            className="flex items-center gap-1 rounded-md px-1 py-1 text-[0.625rem] text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <MessageSquarePlus className="size-3.5" />
            {feedback.note ? feedback.note : t.inbox.addNote}
          </button>
        ) : null}
      </div>
      {feedback && noteOpen ? (
        <div className="flex w-64 items-center gap-1.5">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveNote()}
            placeholder={t.inbox.notePlaceholder}
            className="h-7 flex-1 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <button
            type="button"
            onClick={saveNote}
            disabled={pending}
            className="text-[0.625rem] text-muted-foreground hover:text-foreground"
          >
            {t.inbox.saveNote}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DeliveryTag({
  status,
  error,
}: {
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
}) {
  const t = useTranslations();
  if (status === "failed") {
    return (
      <span className="text-destructive">
        {t.inbox.notDelivered}
        {error ? ` · ${error}` : ""}
      </span>
    );
  }
  return <span className="capitalize">{t.inbox.deliveryStatus[status]}</span>;
}

function TemplatePicker({
  channel,
  conversationId,
  onInsert,
  onSent,
}: {
  channel: ChannelKind;
  conversationId: string;
  onInsert: (rendered: string) => void;
  onSent: (message: ConversationMessage) => void;
}) {
  const t = useTranslations();
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplateRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [preview, setPreview] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(list);
      })
      .catch(() => toast.error(t.inbox.couldNotLoadTemplates))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Approved templates are a WhatsApp mechanism: the API 409s them on
  // Messenger/Instagram (Feature 16), so only canned replies are offered there.
  const usable =
    channel === "whatsapp"
      ? templates
      : templates.filter((tpl) => tpl.kind === "canned_reply");
  const selected = usable.find((tpl) => tpl.id === selectedId) ?? null;

  function select(tpl: MessageTemplateRecord) {
    setSelectedId(tpl.id);
    setValues(tpl.variables.map((v) => v.example ?? ""));
    setPreview(tpl.variables.length === 0 ? tpl.body : "");
  }

  async function runPreview() {
    if (!selected) return;
    setPreviewing(true);
    try {
      const res = await previewTemplate(selected.id, values);
      setPreview(res.text);
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.inbox.couldNotPreview));
    } finally {
      setPreviewing(false);
    }
  }

  async function insert() {
    if (!selected) return;
    if (selected.variables.length === 0) {
      onInsert(selected.body);
      return;
    }
    if (!preview) {
      await runPreview();
      return;
    }
    onInsert(preview);
  }

  async function sendApproved() {
    if (!selected || selected.approvalStatus !== "approved" || sending) return;
    setSending(true);
    const clientMessageId = crypto.randomUUID();
    try {
      const res = await sendTemplateMessage(conversationId, selected.id, values, clientMessageId);
      onSent({
        id: res.messageId,
        role: "human_agent",
        content: res.text,
        createdAt: new Date().toISOString(),
        deliveryStatus: res.delivered ? "sent" : "failed",
        deliveryError: res.deliveryError,
        authorUserId: null,
        feedback: null,
        media: null,
      });
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.inbox.couldNotSendTemplate));
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-border p-6">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (usable.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
        {t.inbox.noTemplatesYet}
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {usable.map((tpl) => (
          <button
            key={tpl.id}
            type="button"
            onClick={() => select(tpl)}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-start text-sm transition-colors",
              selectedId === tpl.id ? "bg-lime-soft/60" : "hover:bg-secondary/60",
            )}
          >
            <span className="truncate">{tpl.name}</span>
            <span className="eyebrow shrink-0 text-muted-foreground">
              {tpl.kind === "whatsapp_template"
                ? tpl.approvalStatus === "approved"
                  ? t.templates.statusApproved
                  : t.templates.statusPending
                : t.templates.kindCanned}
            </span>
          </button>
        ))}
      </div>

      {selected ? (
        <div className="space-y-2 border-t border-border pt-3">
          {selected.variables.length > 0 ? (
            <div className="space-y-1.5">
              {selected.variables.map((v, i) => (
                <input
                  key={v.position}
                  value={values[i] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => prev.map((val, idx) => (idx === i ? e.target.value : val)))
                  }
                  placeholder={v.label}
                  className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                />
              ))}
              <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
                {previewing ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t.inbox.previewTemplate}
              </Button>
            </div>
          ) : null}

          {preview ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">{preview}</p>
          ) : null}

          <div className="flex items-center gap-2">
            {selected.kind === "canned_reply" ? (
              <Button size="sm" onClick={insert}>
                {t.inbox.insertTemplate}
              </Button>
            ) : selected.approvalStatus === "approved" ? (
              <Button size="sm" onClick={sendApproved} disabled={sending}>
                {sending ? <Loader2 className="size-3.5 animate-spin" /> : <SendHorizontal className="size-3.5" />}
                {t.inbox.sendTemplate}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{t.inbox.templateNotApproved}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  sending,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
}) {
  const t = useTranslations();
  return (
    <div className="flex items-end gap-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        placeholder={t.inbox.replyPlaceholder}
        className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <Button
        size="icon"
        onClick={onSend}
        disabled={sending || value.trim().length === 0}
        aria-label={t.inbox.sendReplyAria}
      >
        {sending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <SendHorizontal className="size-4" />
        )}
      </Button>
    </div>
  );
}
