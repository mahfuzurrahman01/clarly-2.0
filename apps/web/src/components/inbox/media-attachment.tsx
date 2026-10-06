"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  ImageIcon,
  Loader2,
  Paperclip,
  Pause,
  Play,
} from "lucide-react";
import type { Media } from "@/lib/api/inbox";
import { useTranslations } from "@/lib/i18n/provider";

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function MediaAttachment({
  conversationId,
  messageId,
  media,
}: {
  conversationId: string;
  messageId: string;
  media: Media;
}) {
  const t = useTranslations();
  const proxyUrl = `/api/conversations/${conversationId}/messages/${messageId}/media`;
  const isImage = media.mimeType?.startsWith("image/") ?? false;
  const size = formatBytes(media.sizeBytes);

  if (media.status === "pending") {
    return (
      <Chip>
        <Loader2 className="size-3.5 animate-spin" />
        {t.inbox.receivingAttachment}
      </Chip>
    );
  }

  if (media.status === "failed") {
    return (
      <Chip tone="danger">
        <AlertTriangle className="size-3.5" />
        {t.inbox.attachmentFailed}
        {media.error ? ` — ${media.error}` : null}
      </Chip>
    );
  }

  if (media.status === "too_large") {
    return (
      <Chip tone="danger">
        <AlertTriangle className="size-3.5" />
        {t.inbox.attachmentTooLarge}
        {size ? ` (${size})` : null}
      </Chip>
    );
  }

  const isAudio = media.mimeType?.startsWith("audio/") ?? false;

  // stored
  if (isImage) {
    return <ImagePreview url={proxyUrl} filename={media.filename} />;
  }

  if (isAudio) {
    return (
      <VoiceNotePlayer
        url={proxyUrl}
        filename={media.filename}
        transcript={media.transcript}
      />
    );
  }

  return (
    <a
      href={proxyUrl}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors hover:bg-secondary/60"
    >
      <Paperclip className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{media.filename ?? t.inbox.attachment}</span>
      {size ? (
        <span className="shrink-0 text-xs text-muted-foreground">{size}</span>
      ) : null}
      <Download className="size-4 shrink-0 text-muted-foreground" />
    </a>
  );
}

function ImagePreview({
  url,
  filename,
}: {
  url: string;
  filename: string | null;
}) {
  const t = useTranslations();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error();
        const blob = await res.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (failed) {
    return (
      <a
        href={url}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:bg-secondary/60"
      >
        <ImageIcon className="size-4 text-muted-foreground" />
        {filename ?? t.inbox.image}
        <Download className="size-4 text-muted-foreground" />
      </a>
    );
  }

  if (!src) {
    return (
      <Chip>
        <Loader2 className="size-3.5 animate-spin" />
        {t.inbox.loadingImage}
      </Chip>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- blob URL of an
    // authenticated fetch; next/image can't proxy it and shouldn't cache it.
    <img
      src={src}
      alt={filename ?? t.inbox.attachmentAlt}
      className="max-h-72 max-w-full rounded-lg border border-border object-contain"
    />
  );
}

function VoiceNotePlayer({
  url,
  filename,
  transcript,
}: {
  url: string;
  filename: string | null;
  transcript: string | null;
}) {
  const t = useTranslations();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setProgress(el.currentTime);
    const onLoaded = () => setDuration(el.duration);
    const onPlay = () => setPlaying(true);
    // Fires for a manual pause, the end of playback, and OS media-key pause —
    // `ended` also fires `pause` first, so a separate `ended` listener isn't
    // needed to reset the button.
    const onPause = () => setPlaying(false);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
    };
  }, []);

  function toggle() {
    const el = audioRef.current;
    if (!el) return;
    setPlaybackError(false);
    if (playing) {
      el.pause();
      return;
    }
    // play() returns a promise that rejects on autoplay-policy or load
    // failure — the `play`/`pause` listeners above are the source of truth
    // for `playing`, so a rejection here only needs to surface the error.
    el.play().catch(() => setPlaybackError(true));
  }

  const pct = duration > 0 ? (progress / duration) * 100 : 0;

  return (
    <div className="inline-flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2">
      <div className="inline-flex items-center gap-2">
        <audio ref={audioRef} src={url} preload="metadata" />
        <button
          type="button"
          onClick={toggle}
          className="size-7 shrink-0 rounded-full bg-lime-600 text-white flex items-center justify-center hover:bg-lime-700 transition-colors"
          aria-label={playing ? t.inbox.pauseVoiceNote : t.inbox.playVoiceNote}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 ms-0.5" />}
        </button>
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-xs text-muted-foreground truncate max-w-[160px]">
            {filename ?? t.inbox.voiceNote}
          </span>
          <div className="w-28 h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-lime-600 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {formatDuration(progress)} / {formatDuration(duration)}
        </span>
        {transcript ? (
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            aria-label={showTranscript ? t.inbox.hideTranscript : t.inbox.showTranscript}
            aria-expanded={showTranscript}
          >
            {showTranscript ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>
      {playbackError ? (
        <span className="text-xs text-destructive">{t.inbox.voiceNotePlaybackError}</span>
      ) : null}
      {transcript && showTranscript ? (
        <p className="max-w-72 whitespace-pre-wrap text-xs text-muted-foreground border-t border-border pt-1.5">
          {transcript}
        </p>
      ) : null}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Chip({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "danger";
}) {
  return (
    <span
      className={
        tone === "danger"
          ? "inline-flex items-center gap-1.5 text-xs text-destructive"
          : "inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}
