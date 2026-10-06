import { apiFetch, browserApiFetch } from "./client";

/**
 * Clarly 2.0 S3 — console client for `/widget` (Settings → Website chat).
 * Contract of record: the "v2 S3 — Website chat widget" entry in docs/HANDOFF.md.
 */

export type WidgetPosition = "right" | "left";
export type WidgetLocale = "auto" | "ar" | "en";

export type WidgetConfig = {
  id: string;
  /** Public by design: it goes in the embed snippet. */
  publicKey: string;
  enabled: boolean;
  /** Exact origins, normalised by the API (`https://shop.example.com`). */
  allowedOrigins: string[];
  title: string | null;
  welcomeMessage: string | null;
  accentColor: string;
  position: WidgetPosition;
  locale: WidgetLocale;
  updatedAt: string;
};

export type WidgetPatch = Partial<
  Pick<
    WidgetConfig,
    "enabled" | "allowedOrigins" | "title" | "welcomeMessage" | "accentColor" | "position" | "locale"
  >
>;

/** Server-side read. Creates the widget (disabled) on first read. */
export function getWidget(token: string) {
  return apiFetch<WidgetConfig>("/widget", { token });
}

export function updateWidget(patch: WidgetPatch) {
  return browserApiFetch<WidgetConfig>("/widget", { method: "PATCH", json: patch });
}

export function rotateWidgetKey() {
  return browserApiFetch<WidgetConfig>("/widget/rotate-key", { method: "POST" });
}

/** The snippet a tenant pastes before `</body>` on their website. */
export function embedSnippet(consoleOrigin: string, apiBase: string, publicKey: string): string {
  return `<script src="${consoleOrigin}/widget.js" data-key="${publicKey}" data-api="${apiBase}" async></script>`;
}
