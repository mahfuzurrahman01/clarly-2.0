"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";
import { cn } from "./cn";

/**
 * Built on the native <dialog> element rather than a div with a portal.
 *
 * `showModal()` gives focus trapping, Escape-to-close, focus restoration to
 * the trigger, inert background content, and top-layer stacking — all of it
 * correct, from the browser, with no dependency and no chance of a
 * hand-rolled trap drifting out of spec.
 */
function useNativeDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Fires for Escape and for form[method=dialog] alike, so state stays in
    // sync however the dialog was dismissed.
    const handleClose = () => onClose();
    node.addEventListener("close", handleClose);
    return () => node.removeEventListener("close", handleClose);
  }, [onClose]);

  return ref;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  const ref = useNativeDialog(open, onClose);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      // Clicking the backdrop closes: the click lands on the dialog element
      // itself only when it is outside the inner content box.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] rounded-overlay border border-border bg-surface p-0 text-ink shadow-overlay",
        size === "sm" && "max-w-sm",
        size === "md" && "max-w-md",
        size === "lg" && "max-w-2xl",
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 id="dialog-title" className="text-sm font-semibold">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded-control px-1 text-ink-faint hover:text-ink"
        >
          &times;
        </button>
      </div>

      {children ? <div className="px-5 py-5 text-sm">{children}</div> : null}

      {footer ? (
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * Confirmation for an action that cannot be undone.
 *
 * `confirmPhrase` raises the bar for the genuinely irreversible ones: when
 * archiving an agent releases a live WhatsApp number, a reflexive click on a
 * button positioned where "OK" usually sits is not consent.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = "Confirm",
  confirmPhrase,
  destructive = true,
  pending = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  confirmPhrase?: string;
  destructive?: boolean;
  pending?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const satisfied = !confirmPhrase || typed.trim() === confirmPhrase;

  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={pending}
            disabled={!satisfied}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-ink-muted">{body}</p>
      {confirmPhrase ? (
        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-sm">
            Type <span className="font-mono font-medium">{confirmPhrase}</span>{" "}
            to confirm
          </span>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="h-9 rounded-control border border-border bg-canvas px-3 text-sm"
          />
        </label>
      ) : null}
    </Dialog>
  );
}

/**
 * Edge-anchored panel. Below `lg` it takes the full screen — a 26rem drawer
 * on a 375px viewport is a modal with the content cropped.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useNativeDialog(open, onClose);

  return (
    <dialog
      ref={ref}
      aria-labelledby="drawer-title"
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        "m-0 h-dvh max-h-dvh w-screen max-w-full bg-surface p-0 text-ink",
        "lg:ml-auto lg:w-[28rem] lg:border-l lg:border-border lg:shadow-overlay",
      )}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <h2 id="drawer-title" className="min-w-0 text-sm font-semibold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-control px-1 text-ink-faint hover:text-ink"
          >
            &times;
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {children}
        </div>
        {footer ? (
          <div className="border-t border-border px-5 py-3">{footer}</div>
        ) : null}
      </div>
    </dialog>
  );
}
