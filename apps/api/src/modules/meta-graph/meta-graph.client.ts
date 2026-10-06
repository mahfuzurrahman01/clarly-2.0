// Channel (MetaGraphModule, Gulf T1 / D8): the ONLY place in the codebase
// that performs network I/O against graph.facebook.com — for WhatsApp Cloud
// API (MetaCloudAdapter: sends, templates, media) and for the Messenger /
// Instagram social channels (MetaChannelModule: Send API, token lifecycle)
// alike. One place for the Graph base URL + version, request timeouts,
// bearer auth, and Meta's error envelope (`MetaGraphError`).
//
// Isolated into its own injectable for one concrete reason: every layer
// above this one — the adapters, the token lifecycle, the webhook path, the
// respond path — must be fully testable against a fake. That is exactly
// what a single seam buys: callers' tests inject a fake MetaGraphClient and
// exercise real code everywhere else, rather than stubbing `global.fetch`
// and hoping the call shape was right. This file's own spec is the one
// place that stubs `fetch`.
import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../core';
import { MetaGraphError } from './meta-graph.error';

export interface GraphSendMessageInput {
  /** The PAGE id — Instagram DMs are sent through the linked page, not through the IG account id. */
  pageId: string;
  pageAccessToken: string;
  /** PSID (Messenger) or IGSID (Instagram). */
  recipientId: string;
  text: string;
  /** Meta message tag for an out-of-window send (e.g. HUMAN_AGENT). Omitted inside the window. */
  tag?: string;
}

export interface GraphSendMessageResult {
  /** Meta's `message_id` (`mid.*`). */
  messageId: string;
}

export interface GraphTokenExchangeInput {
  /** The long-lived USER token to exchange. */
  userAccessToken: string;
}

export interface GraphTokenExchangeResult {
  accessToken: string;
  /** Seconds until expiry, when Meta reports one. Absent for non-expiring tokens. */
  expiresInSeconds: number | null;
}

export interface GraphPageTokenInput {
  userAccessToken: string;
  pageId: string;
}

/** An Instagram professional account linked to a Facebook page. */
export interface GraphLinkedInstagramAccount {
  id: string;
  username: string | null;
}

/** One entry of `GET /me/accounts`: a page the user has a role on, with Meta's own page token for it. */
export interface GraphManagedPage {
  id: string;
  name: string | null;
  /** The PAGE access token Meta issued for this user on this page. A secret: never return it to a client. */
  accessToken: string;
  instagram: GraphLinkedInstagramAccount | null;
}

export interface GraphSubscribeAppInput {
  pageId: string;
  pageAccessToken: string;
  /** Page webhook fields, e.g. `messages`. Sent comma-separated, as Meta documents. */
  subscribedFields: readonly string[];
}

/** Gulf T8: which product's comment API to address. Facebook and Instagram name their comment edges differently. */
export type GraphCommentSurface = 'facebook' | 'instagram';

export interface GraphCommentReplyInput {
  surface: GraphCommentSurface;
  commentId: string;
  message: string;
  pageAccessToken: string;
}

export interface GraphHideCommentInput {
  surface: GraphCommentSurface;
  commentId: string;
  pageAccessToken: string;
}

export interface GraphPrivateReplyInput {
  /** The PAGE id, for Instagram comments too. */
  pageId: string;
  commentId: string;
  text: string;
  pageAccessToken: string;
}

export interface GraphPrivateReplyResult {
  /** PSID (Facebook) or IGSID (Instagram) of the commenter. */
  recipientId: string;
  messageId: string;
}

/**
 * The fields read per page from `/me/accounts`. `instagram_business_account`
 * is the IG professional account linked to the page, which is where
 * Instagram DMs for that page arrive.
 */
const MANAGED_PAGE_FIELDS =
  'id,name,access_token,instagram_business_account{id,username}';

/** Page size for `/me/accounts`. Meta's documented maximum for most edges is 100. */
const MANAGED_PAGES_PAGE_SIZE = '100';

/**
 * Hard stop on `/me/accounts` pagination: 20 x 100 pages. A user who admins
 * more than that is not a tenant we can show a picker to anyway, and an
 * upstream bug that always returns `next` must not loop forever.
 */
const MANAGED_PAGES_MAX_REQUESTS = 20;

/**
 * Query-string keys whose values are credentials. The social token calls
 * authenticate in the query string (Meta's documented form for those
 * endpoints), so these values are redacted from any error message exactly
 * like a bearer token is.
 */
const CREDENTIAL_QUERY_KEYS = [
  'access_token',
  'client_secret',
  'fb_exchange_token',
  'input_token',
  // Gulf T3: the single-use Embedded Signup authorization code.
  'code',
] as const;

/** Gulf T3 (D3): one entry of debug_token's `granular_scopes`. */
export interface GraphGranularScope {
  scope: string;
  /** Asset ids the permission was granted on (WABA ids for the WhatsApp scopes). Empty when Meta granted it app-wide. */
  targetIds: string[];
}

/** Gulf T3 (D3): what debug_token says about a token, including which assets it was granted on. */
export interface GraphTokenScopes {
  valid: boolean;
  /** The app the token was issued to. Must be ours before any granted id is believed. */
  appId: string | null;
  /**
   * Gulf T5: debug_token's `user_id`, the Meta user the token belongs to.
   * Recorded (hashed) on the WhatsApp number so Meta's deauthorize callback
   * can find it. Null when Meta omits it.
   */
  userId: string | null;
  granularScopes: GraphGranularScope[];
}

const REDACTED = '[redacted]';

@Injectable()
export class MetaGraphClient {
  constructor(private readonly config: AppConfigService) {}

  private get base(): string {
    return `${this.config.metaGraphBaseUrl}/${this.config.metaGraphVersion}`;
  }

  /**
   * `POST /{page-id}/messages` — the Send API, shared verbatim by Messenger
   * and Instagram. There is no `messaging_product` discriminator and no
   * separate Instagram endpoint: which inbox the message lands in is decided
   * by which id the recipient is, which is why the adapter above never
   * branches on channel to send.
   */
  async sendMessage(
    input: GraphSendMessageInput,
  ): Promise<GraphSendMessageResult> {
    const body: Record<string, unknown> = {
      recipient: { id: input.recipientId },
      message: { text: input.text },
      // MESSAGE_TAG is the only messaging_type that carries a tag; RESPONSE
      // is the correct value for an in-window reply to a customer.
      messaging_type: input.tag ? 'MESSAGE_TAG' : 'RESPONSE',
      ...(input.tag ? { tag: input.tag } : {}),
    };

    const payload = await this.post(
      `${input.pageId}/messages`,
      body,
      input.pageAccessToken,
    );

    const messageId = (payload as { message_id?: unknown }).message_id;
    if (typeof messageId !== 'string') {
      throw new MetaGraphError(
        200,
        null,
        null,
        'Meta accepted the send but returned no message_id — the reply cannot be tracked.',
      );
    }
    return { messageId };
  }

  /**
   * `GET /oauth/access_token?grant_type=fb_exchange_token` — extends a
   * long-lived USER token.
   *
   * Note what this is NOT: page tokens have no refresh grant of their own.
   * The supported way to get a fresh page token is to re-read
   * `/{page-id}?fields=access_token` with a valid user token, which is why
   * MetaTokenService always does the two calls in that order.
   */
  async exchangeLongLivedUserToken(
    input: GraphTokenExchangeInput,
  ): Promise<GraphTokenExchangeResult> {
    const url = new URL(`${this.base}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', this.config.metaAppId);
    url.searchParams.set('client_secret', this.config.metaAppSecret);
    url.searchParams.set('fb_exchange_token', input.userAccessToken);

    const payload = await this.getWithQueryAuth(url);
    const accessToken = (payload as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new MetaGraphError(
        200,
        null,
        null,
        'Meta returned a token exchange response with no access_token.',
      );
    }
    const expiresIn = (payload as { expires_in?: unknown }).expires_in;

    return {
      accessToken,
      expiresInSeconds: typeof expiresIn === 'number' ? expiresIn : null,
    };
  }

  /** `GET /{page-id}?fields=access_token` — mints a fresh PAGE token from a valid user token. */
  async fetchPageAccessToken(input: GraphPageTokenInput): Promise<string> {
    const url = new URL(`${this.base}/${input.pageId}`);
    url.searchParams.set('fields', 'access_token');
    url.searchParams.set('access_token', input.userAccessToken);

    const payload = await this.getWithQueryAuth(url);
    const token = (payload as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new MetaGraphError(
        200,
        null,
        null,
        `Meta returned no access_token for page ${input.pageId} — the connected user may no longer administer it.`,
      );
    }
    return token;
  }

  /**
   * `GET /debug_token` — asks Meta what it thinks of a token, including when
   * it expires. Used at connect time so `token_expires_at` is Meta's own
   * answer rather than an assumption about "60 days".
   */
  async inspectToken(
    token: string,
  ): Promise<{ valid: boolean; expiresAt: Date | null }> {
    const url = new URL(`${this.base}/debug_token`);
    url.searchParams.set('input_token', token);
    // App-token form: Meta accepts `{app-id}|{app-secret}` where an access
    // token is expected. Avoids a separate app-token round trip.
    url.searchParams.set(
      'access_token',
      `${this.config.metaAppId}|${this.config.metaAppSecret}`,
    );

    const payload = await this.getWithQueryAuth(url);
    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    const expiresAt = data.expires_at;

    return {
      valid: data.is_valid === true,
      // Meta reports 0 for "never expires" — genuinely different from
      // "expires at the epoch", and treating it as a date would mark every
      // system-user token as long overdue for refresh.
      expiresAt:
        typeof expiresAt === 'number' && expiresAt > 0
          ? new Date(expiresAt * 1000)
          : null,
    };
  }

  // ---- Gulf T3 (D3): WhatsApp Embedded Signup ----

  /**
   * `GET /oauth/access_token?client_id&client_secret&code` — exchanges the
   * single-use `code` the Embedded Signup popup returns for a business
   * integration system user access token. Meta's documented form for a Tech
   * Provider: no `redirect_uri`, no `grant_type`. The code is short-lived
   * and single-use, so a 4xx here means "reused or expired" and is never
   * worth retrying.
   */
  async exchangeEmbeddedSignupCode(
    code: string,
  ): Promise<GraphTokenExchangeResult> {
    const url = new URL(`${this.base}/oauth/access_token`);
    url.searchParams.set('client_id', this.config.metaAppId);
    url.searchParams.set('client_secret', this.config.metaAppSecret);
    url.searchParams.set('code', code);

    const payload = await this.getWithQueryAuth(url);
    const accessToken = (payload as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new MetaGraphError(
        200,
        null,
        null,
        'Meta returned a code exchange response with no access_token.',
      );
    }
    const expiresIn = (payload as { expires_in?: unknown }).expires_in;
    return {
      accessToken,
      expiresInSeconds: typeof expiresIn === 'number' ? expiresIn : null,
    };
  }

  /**
   * `GET /debug_token`, keeping `app_id` and `granular_scopes` — the only
   * trustworthy statement of WHICH WABAs a business token was granted on.
   * The browser-reported `waba_id` is checked against this, never trusted.
   */
  async inspectTokenScopes(token: string): Promise<GraphTokenScopes> {
    const url = new URL(`${this.base}/debug_token`);
    url.searchParams.set('input_token', token);
    url.searchParams.set(
      'access_token',
      `${this.config.metaAppId}|${this.config.metaAppSecret}`,
    );

    const payload = await this.getWithQueryAuth(url);
    const data = (payload as { data?: Record<string, unknown> }).data ?? {};
    const rawScopes = Array.isArray(data.granular_scopes)
      ? (data.granular_scopes as unknown[])
      : [];

    return {
      valid: data.is_valid === true,
      appId: typeof data.app_id === 'string' ? data.app_id : null,
      userId:
        typeof data.user_id === 'string' && data.user_id.length > 0
          ? data.user_id
          : null,
      granularScopes: rawScopes.flatMap((entry) => {
        const scope = (entry as { scope?: unknown } | null)?.scope;
        if (typeof scope !== 'string') return [];
        const targets = (entry as { target_ids?: unknown }).target_ids;
        return [
          {
            scope,
            targetIds: Array.isArray(targets)
              ? targets.filter((id): id is string => typeof id === 'string')
              : [],
          },
        ];
      }),
    };
  }

  /**
   * `GET /me?fields=id`: the app-scoped id of the Facebook user who owns
   * this token. Recorded (hashed) on every channel they connect so Meta's
   * deauthorize and data-deletion callbacks can find those rows.
   */
  async getMe(userAccessToken: string): Promise<{ id: string }> {
    const payload = await this.get('me', userAccessToken, { fields: 'id' });
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new MetaGraphError(
        200,
        null,
        null,
        'Meta returned no user id for /me.',
      );
    }
    return { id };
  }

  /**
   * `GET /me/accounts`: every page the user has a role on, each with Meta's
   * own page token and its linked Instagram professional account.
   *
   * Paginates on `paging.cursors.after` while Meta reports `paging.next`,
   * re-issuing the request with bearer auth rather than following `next`
   * verbatim (that URL carries the user token in its query string). Entries
   * without an id or page token are dropped: they cannot be connected.
   */
  async listPages(userAccessToken: string): Promise<GraphManagedPage[]> {
    const pages: GraphManagedPage[] = [];
    let after: string | null = null;

    for (let request = 0; request < MANAGED_PAGES_MAX_REQUESTS; request++) {
      const payload = (await this.get('me/accounts', userAccessToken, {
        fields: MANAGED_PAGE_FIELDS,
        limit: MANAGED_PAGES_PAGE_SIZE,
        ...(after ? { after } : {}),
      })) as {
        data?: unknown;
        paging?: { next?: unknown; cursors?: { after?: unknown } };
      } | null;

      const data = Array.isArray(payload?.data) ? payload.data : [];
      pages.push(...data.flatMap(toManagedPage));

      const nextCursor = payload?.paging?.cursors?.after;
      if (
        typeof payload?.paging?.next !== 'string' ||
        typeof nextCursor !== 'string' ||
        nextCursor.length === 0
      ) {
        break;
      }
      after = nextCursor;
    }

    return pages;
  }

  /**
   * `POST /{page-id}/subscribed_apps`: subscribes our app to this page's
   * webhooks. Authenticated with the PAGE token (Meta requires one, plus
   * `pages_manage_metadata`). Covers Instagram DMs too: for an IG account
   * linked to a page, Meta's Instagram webhooks are enabled by subscribing
   * that page.
   */
  async subscribeApp(input: GraphSubscribeAppInput): Promise<void> {
    const payload = await this.post(
      `${input.pageId}/subscribed_apps`,
      { subscribed_fields: input.subscribedFields.join(',') },
      input.pageAccessToken,
    );
    if ((payload as { success?: unknown } | null)?.success !== true) {
      throw new MetaGraphError(
        200,
        null,
        null,
        `Meta did not confirm the webhook subscription for page ${input.pageId}.`,
      );
    }
  }

  // ---- Gulf T8 (D6): comment automation ----

  /**
   * Public reply under a comment. Facebook: `POST /{comment-id}/comments`.
   * Instagram: `POST /{ig-comment-id}/replies` (a reply to a reply lands on
   * the top-level comment, per Meta). Both answer `{ id }`.
   */
  async replyToComment(input: GraphCommentReplyInput): Promise<{ id: string }> {
    const edge = input.surface === 'instagram' ? 'replies' : 'comments';
    const payload = await this.post(
      `${input.commentId}/${edge}`,
      { message: input.message },
      input.pageAccessToken,
    );
    const id = (payload as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new MetaGraphError(
        200,
        null,
        null,
        `Meta accepted the reply to comment ${input.commentId} but returned no id.`,
      );
    }
    return { id };
  }

  /**
   * Hides a comment from everyone but its author and the page. Facebook:
   * `POST /{comment-id}` with `is_hidden=true`; Instagram: `POST
   * /{ig-comment-id}` with `hide=true`. Both answer `{ success }`.
   */
  async hideComment(input: GraphHideCommentInput): Promise<void> {
    const body =
      input.surface === 'instagram' ? { hide: true } : { is_hidden: true };
    const payload = await this.post(
      input.commentId,
      body,
      input.pageAccessToken,
    );
    if ((payload as { success?: unknown } | null)?.success !== true) {
      throw new MetaGraphError(
        200,
        null,
        null,
        `Meta did not confirm hiding comment ${input.commentId}.`,
      );
    }
  }

  /**
   * Private reply: `POST /{page-id}/messages` with `recipient.comment_id`,
   * the same Send API for Facebook and Instagram, always with the PAGE id and
   * page token. Meta allows one per comment, within 7 days of it. The answer
   * names the commenter's PSID/IGSID, which is how their later DM is matched
   * back to this comment (D15b).
   */
  async sendPrivateReply(
    input: GraphPrivateReplyInput,
  ): Promise<GraphPrivateReplyResult> {
    const payload = (await this.post(
      `${input.pageId}/messages`,
      {
        recipient: { comment_id: input.commentId },
        message: { text: input.text },
      },
      input.pageAccessToken,
    )) as { recipient_id?: unknown; message_id?: unknown } | null;
    const recipientId = payload?.recipient_id;
    const messageId = payload?.message_id;
    if (
      typeof recipientId !== 'string' ||
      recipientId.length === 0 ||
      typeof messageId !== 'string' ||
      messageId.length === 0
    ) {
      throw new MetaGraphError(
        200,
        null,
        null,
        `Meta accepted the private reply to comment ${input.commentId} but returned no recipient_id/message_id.`,
      );
    }
    return { recipientId, messageId };
  }

  /**
   * `GET {base}/{version}/{path}` with bearer auth. Returns the parsed JSON
   * body (or null for an empty 2xx body); throws `MetaGraphError` on a
   * non-2xx response or a 2xx body that is not JSON.
   */
  async get(
    path: string,
    accessToken: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<unknown> {
    const url = this.url(path);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: this.timeoutSignal(),
    });
    return this.parse(response, [accessToken]);
  }

  /** `POST {base}/{version}/{path}` with a JSON body and bearer auth. Same return/throw contract as {@link get}. */
  async post(
    path: string,
    body: unknown,
    accessToken: string,
  ): Promise<unknown> {
    const response = await fetch(this.url(path).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: this.timeoutSignal(),
    });
    return this.parse(response, [accessToken]);
  }

  /**
   * `GET <absoluteUrl>` with bearer auth, returning the raw bytes. For the
   * short-lived signed media URL `GET /{media-id}` hands back: it lives on a
   * different host than the Graph base, yet still requires the bearer token
   * (omitting it 401s). Throws `MetaGraphError` on a non-2xx response.
   */
  async getBinary(absoluteUrl: string, accessToken: string): Promise<Buffer> {
    const response = await fetch(absoluteUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: this.timeoutSignal(),
    });
    if (!response.ok) {
      await this.parse(response, [accessToken]);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private url(path: string): URL {
    return new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
  }

  private timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(this.config.bspRequestTimeoutMs);
  }

  /** GET for the endpoints that authenticate in the QUERY STRING (token exchange, page token, debug_token) — no Authorization header, same as Meta documents them. */
  private async getWithQueryAuth(url: URL): Promise<unknown> {
    const response = await fetch(url.toString(), {
      signal: this.timeoutSignal(),
    });
    const secrets = CREDENTIAL_QUERY_KEYS.flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [value] : [];
    });
    return this.parse(response, secrets);
  }

  private async parse(
    response: Response,
    secrets: readonly string[],
  ): Promise<unknown> {
    const text = await response.text().catch(() => '');
    let payload: unknown = null;
    let parseable = true;
    try {
      payload = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      payload = null;
      parseable = false;
    }

    if (!response.ok) {
      const error =
        (payload as { error?: Record<string, unknown> } | null)?.error ?? {};
      throw new MetaGraphError(
        response.status,
        typeof error.code === 'number' ? error.code : null,
        typeof error.error_subcode === 'number' ? error.error_subcode : null,
        redact(
          typeof error.message === 'string'
            ? error.message
            : `Meta Graph API returned HTTP ${response.status}: ${text.slice(0, 500)}`,
          secrets,
        ),
      );
    }

    if (!parseable) {
      throw new MetaGraphError(
        response.status,
        null,
        null,
        `Meta Graph API returned HTTP ${response.status} with a non-JSON body.`,
      );
    }

    return payload;
  }
}

/** Maps one raw `/me/accounts` entry; returns [] for an entry that cannot be connected. */
function toManagedPage(raw: unknown): GraphManagedPage[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const entry = raw as {
    id?: unknown;
    name?: unknown;
    access_token?: unknown;
    instagram_business_account?: { id?: unknown; username?: unknown } | null;
  };
  if (typeof entry.id !== 'string' || entry.id.length === 0) return [];
  if (
    typeof entry.access_token !== 'string' ||
    entry.access_token.length === 0
  ) {
    return [];
  }
  const ig = entry.instagram_business_account;
  const instagram: GraphLinkedInstagramAccount | null =
    ig && typeof ig.id === 'string' && ig.id.length > 0
      ? {
          id: ig.id,
          username: typeof ig.username === 'string' ? ig.username : null,
        }
      : null;

  return [
    {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : null,
      accessToken: entry.access_token,
      instagram,
    },
  ];
}

/** Replaces every occurrence of each non-empty secret. Belt and braces: Meta does not echo tokens, but a proxy or a future error shape might. */
function redact(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((acc, secret) => acc.split(secret).join(REDACTED), message);
}
