"use client";

import { useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import {
  fetchProductImageBlob,
  isManagedProductImageUrl,
} from "@/lib/api/catalog";
import { useTranslations } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * Product image, from either of the two places an `imageUrl` can point:
 *
 *  - this API's own `/catalog/products/:id/image` route (an uploaded photo),
 *    which needs the bearer token — so the bytes are fetched and shown as a
 *    blob URL, the same trick the inbox uses for message media;
 *  - any other origin (a merchant CDN, a store sync), loaded directly.
 *
 * `next/image` is deliberately not used: the URL can be on any host, which
 * would need an allow-list in next.config for every merchant.
 *
 * A dead link falls back to the placeholder rather than a broken-image glyph
 * — a catalog full of broken images reads as "the app is broken".
 */
export function ProductThumbnail({
  src,
  name,
  className,
}: {
  src: string | null;
  name: string;
  className?: string;
}) {
  if (!src) return <ImageFallback className={className} />;
  // Keyed by URL so changing the photo remounts rather than resetting
  // load/error state from inside an effect.
  return isManagedProductImageUrl(src) ? (
    <ManagedImage key={src} src={src} name={name} className={className} />
  ) : (
    <DirectImage key={src} src={src} name={name} className={className} />
  );
}

function frameClass(className: string | undefined): string {
  return cn(
    "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary/60",
    className,
  );
}

function ImageFallback({ className }: { className?: string }) {
  const t = useTranslations();
  return (
    <div className={frameClass(className)} title={t.catalog.noImage}>
      <ImageOff
        className="size-4 text-muted-foreground/60"
        aria-hidden="true"
      />
      <span className="sr-only">{t.catalog.noImage}</span>
    </div>
  );
}

function DirectImage({
  src,
  name,
  className,
}: {
  src: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImageFallback className={className} />;
  return (
    <div className={frameClass(className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary
          merchant origin; next/image would need a per-host allow-list. */}
      <img
        src={src}
        alt={name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </div>
  );
}

/** An uploaded photo: authenticated fetch, then a blob URL revoked on unmount. */
function ManagedImage({
  src,
  name,
  className,
}: {
  src: string;
  name: string;
  className?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let active = true;
    fetchProductImageBlob(src)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (failed) return <ImageFallback className={className} />;
  if (!blobUrl)
    return <div className={frameClass(className)} aria-hidden="true" />;

  return (
    <div className={frameClass(className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- blob URL of an
          authenticated fetch; next/image can't proxy it and shouldn't cache it. */}
      <img
        src={blobUrl}
        alt={name}
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </div>
  );
}
