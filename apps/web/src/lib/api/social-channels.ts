// Facebook Messenger + Instagram DM channels (Feature 16, Gulf T4 handshake).
// Contract: docs/HANDOFF.md "Gulf T4 — social connect server-side handshake".
// The browser only ever sends the short-lived *user* token from Facebook
// Login; page tokens never leave the server.
import { apiFetch, browserApiFetch } from "./client";

export type SocialChannelKind = "messenger" | "instagram";

export type SocialChannel = {
  id: string;
  channel: SocialChannelKind;
  /** FB page id (Messenger) or IG professional account id. */
  channelAccountId: string;
  pageId: string;
  displayName: string | null;
  connectionState: "connected" | "reconnect_required";
  connectionError: string | null;
  /** null = Meta reported no expiry, not "expired". */
  tokenExpiresAt: string | null;
};

export type HandshakePage = {
  id: string;
  name: string | null;
  instagram: { id: string; username: string | null } | null;
};

export type SocialHandshake = {
  handshakeId: string;
  expiresAt: string;
  pages: HandshakePage[];
};

export function listSocialChannels(token?: string) {
  const path = "/channels/meta";
  return token
    ? apiFetch<SocialChannel[]>(path, { token })
    : browserApiFetch<SocialChannel[]>(path);
}

/** Step A: trade the short-lived user token for the list of pages it manages. */
export function startSocialHandshake(userAccessToken: string) {
  return browserApiFetch<SocialHandshake>("/channels/meta/pages", {
    method: "POST",
    json: { userAccessToken },
  });
}

/** Step B: connect one page (and/or its linked IG account). 204 on success. */
export function connectSocialPage(input: {
  handshakeId: string;
  pageId: string;
  channels: SocialChannelKind[];
}) {
  return browserApiFetch<void>("/channels/meta", { method: "POST", json: input });
}

export function disconnectSocialChannel(id: string) {
  return browserApiFetch<void>(`/channels/meta/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}
