import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { log } from './log.js';

/**
 * A small OAuth 2.1 authorization server that MCP clients can discover and use,
 * with Kakao Login as the identity provider:
 *
 *   client → /authorize → (redirect) Kakao Login → /oauth/kakao/callback → (redirect) client
 *   client → /token (PKCE) → access + refresh token for this server
 *
 * Kakao only tells us who the person is; whether they may use the server is
 * decided by the allow list. Tokens are opaque; only their hashes are stored.
 */

export interface KakaoOptions {
  /** REST API key of the Kakao app. */
  clientId: string;
  clientSecret?: string | undefined;
  /** Comma-separated consent items to request, e.g. "account_email". */
  scope?: string | undefined;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
}

export const KAKAO_DEFAULT_ENDPOINTS = {
  authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
  tokenUrl: 'https://kauth.kakao.com/oauth/token',
  userInfoUrl: 'https://kapi.kakao.com/v2/user/me',
};

/**
 * A confidential OAuth client registered by configuration rather than dynamically,
 * for services that ask for a client id and secret up front (PlayMCP).
 */
export interface StaticClient {
  clientId: string;
  clientSecret: string;
  /** Exact redirect URIs, or prefixes ending in "*". May be empty until the service reveals its callback. */
  redirectUris: string[];
}

export interface OAuthServerOptions {
  /** Public base URL of this server without a trailing slash, e.g. https://browser.example.com */
  publicUrl: string;
  dataDir: string;
  kakao: KakaoOptions;
  /** Kakao user ids and/or e-mail addresses allowed to log in; "*" allows every Kakao account. */
  allowedUsers: string[];
  accessTokenTtlMs: number;
  refreshTokenTtlMs: number;
  clients?: StaticClient[] | undefined;
}

export interface OAuthUser {
  /** Stable user name used for the workspace directory, e.g. "kakao-123456". */
  user: string;
  kakaoId: string;
  nickname?: string | undefined;
  email?: string | undefined;
}

interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string | undefined;
  createdAt: number;
  /** sha256 of the secret for pre-registered confidential clients; public clients have none. */
  secretHash?: string | undefined;
}

interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string | undefined;
  resource?: string | undefined;
  expires: number;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string | undefined;
  user: OAuthUser;
  expires: number;
}

interface TokenRecord {
  kind: 'access' | 'refresh';
  clientId: string;
  user: OAuthUser;
  resource?: string | undefined;
  expires: number;
  /** For access tokens: hash of the refresh token they were issued with. */
  family: string;
}

interface PersistedState {
  clients: ClientRecord[];
  tokens: Array<TokenRecord & { hash: string }>;
}

export type OAuthOutcome =
  | { kind: 'redirect'; location: string }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'html'; status: number; body: string };

export class OAuthRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'OAuthRequestError';
  }
}

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const CIMD_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const SCOPE = 'browser';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;

/** Paths under the public URL that serve MCP and therefore act as protected resources. */
export const RESOURCE_PATHS: readonly string[] = ['/mcp', '/mcp/lite'];

const stripResource = (value: string): string => value.replace(/#.*$/, '').replace(/\/$/, '');

/** Redirect URIs a public client may register: HTTPS, loopback HTTP, or a custom app scheme. */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  }
  return !/^(javascript|data|file|vbscript):$/.test(url.protocol);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}h1{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${url} answered ${response.status} with a non-JSON body`);
  }
  if (!response.ok) {
    const record = body as Record<string, unknown>;
    const detail = record.error_description ?? record.msg ?? record.error ?? text.slice(0, 200);
    throw new Error(`${url} answered ${response.status}: ${String(detail)}`);
  }
  return body;
}

const CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isAcceptableRedirectPattern(value: string): boolean {
  return isAcceptableRedirectUri(value.endsWith('*') ? value.slice(0, -1) : value);
}

/**
 * Parses --oauth-clients: entries separated by ";" or newlines, each
 * "client_id:client_secret[:redirect_uri[|redirect_uri...]]". A redirect URI ending in
 * "*" allows every URI with that prefix.
 */
export function parseStaticClients(raw: string): StaticClient[] {
  const clients = new Map<string, StaticClient>();
  for (const entry of raw.split(/[;\n]/).map((part) => part.trim()).filter(Boolean)) {
    const first = entry.indexOf(':');
    const second = first === -1 ? -1 : entry.indexOf(':', first + 1);
    if (first <= 0) throw new ConfigError(`OAuth client "${entry}" must look like client_id:client_secret[:redirect_uri]`);
    const clientId = entry.slice(0, first);
    const clientSecret = second === -1 ? entry.slice(first + 1) : entry.slice(first + 1, second);
    const redirectUris = second === -1 ? [] : entry.slice(second + 1).split('|').map((uri) => uri.trim()).filter(Boolean);
    if (!CLIENT_ID_PATTERN.test(clientId)) {
      throw new ConfigError(`OAuth client id "${clientId}" may only contain letters, digits, ".", "_" and "-" (64 characters at most)`);
    }
    if (clientSecret.length < 16) throw new ConfigError(`OAuth client "${clientId}" needs a secret of at least 16 characters`);
    const bad = redirectUris.find((uri) => !isAcceptableRedirectPattern(uri));
    if (bad) throw new ConfigError(`OAuth client "${clientId}": redirect URI "${bad}" must be https (or loopback http), optionally ending in "*"`);
    if (clients.has(clientId)) throw new ConfigError(`OAuth client "${clientId}" is listed twice`);
    clients.set(clientId, { clientId, clientSecret, redirectUris });
  }
  return [...clients.values()];
}

function redirectAllowed(client: ClientRecord, uri: string): boolean {
  return client.redirectUris.some((allowed) => (allowed.endsWith('*') ? uri.startsWith(allowed.slice(0, -1)) : allowed === uri));
}

function formDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** client_id and client_secret from an HTTP Basic header (RFC 6749 section 2.3.1). */
function parseBasicAuth(authorization: string | undefined): { clientId: string; clientSecret: string } | undefined {
  const match = /^\s*Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(authorization ?? '');
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon < 0) return undefined;
  return { clientId: formDecode(decoded.slice(0, colon)), clientSecret: formDecode(decoded.slice(colon + 1)) };
}

function secretMatches(secret: string, hash: string): boolean {
  const presented = Buffer.from(sha256(secret));
  const expected = Buffer.from(hash);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export class OAuthServer {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly staticClients = new Map<string, ClientRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly pending = new Map<string, PendingAuth>();
  private readonly codes = new Map<string, CodeRecord>();
  private readonly cimdCache = new Map<string, { record: ClientRecord; expires: number }>();
  private readonly statePath: string;
  private persistTimer?: NodeJS.Timeout;
  private sweeper?: NodeJS.Timeout;

  constructor(readonly options: OAuthServerOptions) {
    this.statePath = path.join(options.dataDir, 'auth', 'oauth-state.json');
    for (const client of options.clients ?? []) {
      this.staticClients.set(client.clientId, {
        clientId: client.clientId,
        redirectUris: client.redirectUris,
        clientName: client.clientId,
        createdAt: 0,
        secretHash: sha256(client.clientSecret),
      });
    }
  }

  get issuer(): string {
    return this.options.publicUrl;
  }

  /** The default protected resource (the full tool set). */
  get resource(): string {
    return this.resourceUrl('/mcp');
  }

  resourceUrl(resourcePath: string): string {
    return `${this.options.publicUrl}${resourcePath}`;
  }

  /** True when a `resource` parameter names one of this server's MCP endpoints (or is absent). */
  acceptsResource(candidate: string | undefined): boolean {
    if (!candidate) return true;
    const wanted = stripResource(candidate);
    return RESOURCE_PATHS.some((resourcePath) => stripResource(this.resourceUrl(resourcePath)) === wanted);
  }

  private get resourceList(): string {
    return RESOURCE_PATHS.map((resourcePath) => this.resourceUrl(resourcePath)).join(' or ');
  }

  get kakaoRedirectUri(): string {
    return `${this.options.publicUrl}/oauth/kakao/callback`;
  }

  protectedResourceMetadataUrl(resourcePath = '/mcp'): string {
    return `${this.options.publicUrl}/.well-known/oauth-protected-resource${resourcePath}`;
  }

  async start(): Promise<void> {
    await this.load();
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
    log(
      `Kakao login enabled: ${
        this.options.allowedUsers.includes('*')
          ? 'every Kakao account is allowed'
          : `${this.options.allowedUsers.length} allowed user(s)`
      }; Kakao redirect URI ${this.kakaoRedirectUri}`,
    );
    if (this.options.allowedUsers.length === 0) {
      log('warning: --allowed-users is empty, so nobody can log in. Denied logins are logged with their Kakao id.');
    }
    for (const client of this.staticClients.values()) {
      log(`pre-registered OAuth client ${client.clientId}: ${client.redirectUris.length ? client.redirectUris.join(', ') : 'no redirect URI yet'}`);
    }
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persist();
  }

  // ---- discovery documents ----------------------------------------------------

  protectedResourceMetadata(resourcePath = '/mcp'): Record<string, unknown> {
    return {
      resource: this.resourceUrl(resourcePath),
      authorization_servers: [this.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'browser-mcp',
    };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const base = this.issuer;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [SCOPE],
      client_id_metadata_document_supported: true,
    };
  }

  // ---- dynamic client registration (RFC 7591) ---------------------------------

  register(body: unknown): OAuthOutcome {
    if (!body || typeof body !== 'object') {
      return { kind: 'json', status: 400, body: { error: 'invalid_client_metadata', error_description: 'expected a JSON object' } };
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every((uri) => typeof uri === 'string')) {
      return { kind: 'json', status: 400, body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be a non-empty array' } };
    }
    const bad = (redirectUris as string[]).find((uri) => uri.includes('*') || !isAcceptableRedirectUri(uri));
    if (bad) {
      return {
        kind: 'json',
        status: 400,
        body: { error: 'invalid_redirect_uri', error_description: `redirect URI not allowed: ${bad} (use https or a loopback http address)` },
      };
    }
    const authMethod = metadata.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      return {
        kind: 'json',
        status: 400,
        body: { error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method "none") are supported' },
      };
    }
    const record: ClientRecord = {
      clientId: token('mcp_'),
      redirectUris: redirectUris as string[],
      clientName: typeof metadata.client_name === 'string' ? metadata.client_name.slice(0, 200) : undefined,
      createdAt: Date.now(),
    };
    this.clients.set(record.clientId, record);
    this.schedulePersist();
    log(`registered OAuth client ${record.clientId.slice(0, 12)}... (${record.clientName ?? 'unnamed'})`);
    return {
      kind: 'json',
      status: 201,
      body: {
        client_id: record.clientId,
        client_id_issued_at: Math.floor(record.createdAt / 1000),
        redirect_uris: record.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: record.clientName,
        scope: SCOPE,
      },
    };
  }

  /** Registered clients, plus clients identified by a metadata document URL (CIMD). */
  private async resolveClient(clientId: string): Promise<ClientRecord | undefined> {
    const known = this.staticClients.get(clientId) ?? this.clients.get(clientId);
    if (known) return known;
    if (!/^https:\/\//.test(clientId)) return undefined;
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.expires > Date.now()) return cached.record;
    try {
      const document = (await fetchJson(clientId, { headers: { accept: 'application/json' } })) as Record<string, unknown>;
      if (document.client_id !== clientId) throw new Error('client_id in the document does not match its URL');
      const uris = document.redirect_uris;
      if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === 'string' && isAcceptableRedirectUri(uri))) {
        throw new Error('document has no acceptable redirect_uris');
      }
      const record: ClientRecord = {
        clientId,
        redirectUris: uris as string[],
        clientName: typeof document.client_name === 'string' ? document.client_name : undefined,
        createdAt: Date.now(),
      };
      this.cimdCache.set(clientId, { record, expires: Date.now() + CIMD_TTL_MS });
      return record;
    } catch (error) {
      log(`client metadata document ${clientId} rejected: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // ---- authorization ------------------------------------------------------------

  /** Handles GET /authorize: validates the request and sends the person to Kakao Login. */
  async authorize(query: URLSearchParams): Promise<OAuthOutcome> {
    const clientId = query.get('client_id') ?? '';
    const redirectUri = query.get('redirect_uri') ?? '';
    const client = clientId ? await this.resolveClient(clientId) : undefined;
    if (!client) {
      return { kind: 'html', status: 400, body: htmlPage('알 수 없는 클라이언트', 'client_id가 등록되어 있지 않습니다. 클라이언트에서 다시 연결해 주세요.') };
    }
    if (!redirectAllowed(client, redirectUri)) {
      log(`authorize refused: redirect_uri ${redirectUri || '(empty)'} is not registered for client ${clientId}`);
      return {
        kind: 'html',
        status: 400,
        body: htmlPage(
          '잘못된 redirect_uri',
          `이 클라이언트(${clientId})에 등록되지 않은 redirect_uri입니다: ${redirectUri || '(없음)'} — 서버 관리자가 이 주소를 클라이언트 설정에 추가해야 합니다.`,
        ),
      };
    }

    const state = query.get('state') ?? undefined;
    const fail = (error: string, description: string): OAuthOutcome => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      if (state) target.searchParams.set('state', state);
      return { kind: 'redirect', location: target.toString() };
    };

    if (query.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be "code"');
    const codeChallenge = query.get('code_challenge') ?? '';
    if (codeChallenge) {
      if ((query.get('code_challenge_method') ?? 'plain') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    } else if (!client.secretHash) {
      // Public clients must use PKCE; confidential clients prove themselves with their secret.
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const resource = query.get('resource') ?? undefined;
    if (!this.acceptsResource(resource)) return fail('invalid_target', `resource must be ${this.resourceList}`);

    const kakaoState = randomBytes(32).toString('base64url');
    this.pending.set(kakaoState, { clientId, redirectUri, codeChallenge, state, resource, expires: Date.now() + PENDING_TTL_MS });

    const kakao = new URL(this.options.kakao.authorizeUrl);
    kakao.searchParams.set('client_id', this.options.kakao.clientId);
    kakao.searchParams.set('redirect_uri', this.kakaoRedirectUri);
    kakao.searchParams.set('response_type', 'code');
    kakao.searchParams.set('state', kakaoState);
    if (this.options.kakao.scope) kakao.searchParams.set('scope', this.options.kakao.scope);
    return { kind: 'redirect', location: kakao.toString() };
  }

  /** Handles GET /oauth/kakao/callback: finishes Kakao Login and sends a code back to the client. */
  async kakaoCallback(query: URLSearchParams): Promise<OAuthOutcome> {
    const kakaoState = query.get('state') ?? '';
    const pendingAuth = this.pending.get(kakaoState);
    this.pending.delete(kakaoState);
    if (!pendingAuth || pendingAuth.expires < Date.now()) {
      return { kind: 'html', status: 400, body: htmlPage('로그인 세션 만료', '로그인 요청이 만료되었거나 알 수 없습니다. 클라이언트에서 다시 시도해 주세요.') };
    }
    const target = new URL(pendingAuth.redirectUri);
    if (pendingAuth.state) target.searchParams.set('state', pendingAuth.state);
    const fail = (error: string, description: string): OAuthOutcome => {
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      return { kind: 'redirect', location: target.toString() };
    };

    const kakaoError = query.get('error');
    if (kakaoError) return fail('access_denied', `Kakao login failed: ${query.get('error_description') ?? kakaoError}`);
    const code = query.get('code');
    if (!code) return fail('access_denied', 'Kakao login returned no code');

    let user: OAuthUser;
    try {
      user = await this.fetchKakaoUser(code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Kakao login failed: ${message}`);
      return fail('server_error', `Kakao login could not be completed: ${message}`);
    }

    if (!this.isAllowed(user)) {
      log(`login denied: Kakao id ${user.kakaoId}${user.nickname ? ` (${user.nickname})` : ''}${user.email ? ` <${user.email}>` : ''} is not in the allow list`);
      return fail(
        'access_denied',
        `Kakao account ${user.kakaoId}${user.email ? ` (${user.email})` : ''} is not allowed on this server; ask the administrator to add it`,
      );
    }

    await this.writeProfile(user);
    const authCode = token('mcp_code_');
    this.codes.set(sha256(authCode), {
      clientId: pendingAuth.clientId,
      redirectUri: pendingAuth.redirectUri,
      codeChallenge: pendingAuth.codeChallenge,
      resource: pendingAuth.resource,
      user,
      expires: Date.now() + CODE_TTL_MS,
    });
    log(`login: ${user.user}${user.nickname ? ` (${user.nickname})` : ''} via Kakao`);
    target.searchParams.set('code', authCode);
    return { kind: 'redirect', location: target.toString() };
  }

  private async fetchKakaoUser(code: string): Promise<OAuthUser> {
    const { kakao } = this.options;
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: kakao.clientId,
      redirect_uri: this.kakaoRedirectUri,
      code,
    });
    if (kakao.clientSecret) form.set('client_secret', kakao.clientSecret);
    const tokens = (await fetchJson(kakao.tokenUrl, { method: 'POST', body: form })) as { access_token?: unknown };
    if (typeof tokens.access_token !== 'string') throw new Error('Kakao token response has no access_token');

    const info = (await fetchJson(kakao.userInfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })) as { id?: unknown; kakao_account?: { email?: unknown; profile?: { nickname?: unknown } }; properties?: { nickname?: unknown } };
    const id = info.id;
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('Kakao user info has no id');
    const nickname = info.kakao_account?.profile?.nickname ?? info.properties?.nickname;
    const email = info.kakao_account?.email;
    return {
      user: `kakao-${String(id)}`,
      kakaoId: String(id),
      nickname: typeof nickname === 'string' ? nickname : undefined,
      email: typeof email === 'string' ? email.toLowerCase() : undefined,
    };
  }

  private isAllowed(user: OAuthUser): boolean {
    const allowed = this.options.allowedUsers;
    if (allowed.includes('*')) return true;
    return allowed.some((entry) => {
      const value = entry.trim().toLowerCase();
      return value === user.kakaoId || value === `kakao-${user.kakaoId}` || (user.email !== undefined && value === user.email);
    });
  }

  private async writeProfile(user: OAuthUser): Promise<void> {
    try {
      const dir = path.join(this.options.dataDir, 'users', user.user);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'profile.json'),
        JSON.stringify({ kakaoId: user.kakaoId, nickname: user.nickname, email: user.email, lastLogin: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
    } catch (error) {
      log(`could not write profile for ${user.user}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---- tokens -----------------------------------------------------------------------

  /** Handles POST /token for the authorization_code and refresh_token grants. */
  token(form: URLSearchParams, authorization?: string): OAuthOutcome {
    try {
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') return { kind: 'json', status: 200, body: this.exchangeCode(form, authorization) };
      if (grant === 'refresh_token') return { kind: 'json', status: 200, body: this.refresh(form, authorization) };
      throw new OAuthRequestError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (error) {
      if (error instanceof OAuthRequestError) {
        return { kind: 'json', status: error.status, body: { error: error.code, error_description: error.message } };
      }
      throw error;
    }
  }

  /**
   * Checks that the caller is the client a code or refresh token was issued to.
   * Pre-registered clients must present their secret (form fields or HTTP Basic);
   * public clients only state their client_id.
   */
  private authenticateClient(form: URLSearchParams, authorization: string | undefined, expectedClientId: string, requireClientId: boolean): void {
    const basic = parseBasicAuth(authorization);
    const presentedId = basic?.clientId ?? form.get('client_id') ?? undefined;
    const presentedSecret = basic?.clientSecret ?? form.get('client_secret') ?? undefined;
    const confidential = this.staticClients.get(expectedClientId);
    if (confidential) {
      if (presentedId !== expectedClientId || !presentedSecret || !secretMatches(presentedSecret, confidential.secretHash!)) {
        throw new OAuthRequestError('invalid_client', 'client authentication failed', 401);
      }
      return;
    }
    if (presentedId === undefined ? requireClientId : presentedId !== expectedClientId) {
      throw new OAuthRequestError('invalid_grant', 'client_id does not match the grant');
    }
  }

  private exchangeCode(form: URLSearchParams, authorization: string | undefined): unknown {
    const code = form.get('code') ?? '';
    const hash = sha256(code);
    const record = this.codes.get(hash);
    if (!record || record.expires < Date.now()) {
      this.codes.delete(hash);
      throw new OAuthRequestError('invalid_grant', 'authorization code is unknown, used or expired');
    }
    // A caller that cannot prove it is the client does not consume the code.
    this.authenticateClient(form, authorization, record.clientId, true);
    this.codes.delete(hash);
    if ((form.get('redirect_uri') ?? record.redirectUri) !== record.redirectUri) {
      throw new OAuthRequestError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (record.codeChallenge) {
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || challenge !== record.codeChallenge) throw new OAuthRequestError('invalid_grant', 'PKCE code_verifier does not match');
    }
    const resource = form.get('resource') ?? record.resource;
    if (!this.acceptsResource(resource)) throw new OAuthRequestError('invalid_target', `resource must be ${this.resourceList}`);
    return this.issueTokens(record.clientId, record.user, resource);
  }

  private refresh(form: URLSearchParams, authorization: string | undefined): unknown {
    const refreshToken = form.get('refresh_token') ?? '';
    const hash = sha256(refreshToken);
    const record = this.tokens.get(hash);
    if (!record || record.kind !== 'refresh' || record.expires < Date.now()) {
      throw new OAuthRequestError('invalid_grant', 'refresh token is unknown, rotated or expired');
    }
    this.authenticateClient(form, authorization, record.clientId, false);
    const resource = form.get('resource') ?? record.resource;
    if (!this.acceptsResource(resource)) throw new OAuthRequestError('invalid_target', `resource must be ${this.resourceList}`);
    // Rotation: the old refresh token and the access tokens issued with it stop working.
    this.revokeFamily(hash);
    return this.issueTokens(record.clientId, record.user, resource);
  }

  private issueTokens(clientId: string, user: OAuthUser, resource: string | undefined): unknown {
    const accessToken = token('mcp_at_');
    const refreshToken = token('mcp_rt_');
    const family = sha256(refreshToken);
    const now = Date.now();
    this.tokens.set(family, { kind: 'refresh', clientId, user, resource, expires: now + this.options.refreshTokenTtlMs, family });
    this.tokens.set(sha256(accessToken), { kind: 'access', clientId, user, resource, expires: now + this.options.accessTokenTtlMs, family });
    this.schedulePersist();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(this.options.accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: SCOPE,
    };
  }

  private revokeFamily(family: string): void {
    for (const [hash, record] of this.tokens) if (record.family === family) this.tokens.delete(hash);
  }

  /** Handles POST /revoke (RFC 7009): unknown tokens are ignored, as the RFC requires. */
  revoke(form: URLSearchParams): OAuthOutcome {
    const hash = sha256(form.get('token') ?? '');
    const record = this.tokens.get(hash);
    if (record) {
      if (record.kind === 'refresh') this.revokeFamily(record.family);
      else this.tokens.delete(hash);
      this.schedulePersist();
    }
    return { kind: 'json', status: 200, body: {} };
  }

  /** The user an access token belongs to, or undefined when it is unknown or expired. */
  verifyAccessToken(accessToken: string): OAuthUser | undefined {
    const record = this.tokens.get(sha256(accessToken));
    if (!record || record.kind !== 'access' || record.expires < Date.now()) return undefined;
    return record.user;
  }

  // ---- persistence ----------------------------------------------------------------

  private async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const state = JSON.parse(text) as PersistedState;
      const now = Date.now();
      for (const client of state.clients ?? []) this.clients.set(client.clientId, client);
      for (const { hash, ...record } of state.tokens ?? []) if (record.expires > now) this.tokens.set(hash, record);
      log(`loaded ${this.clients.size} OAuth client(s) and ${this.tokens.size} token(s)`);
    } catch (error) {
      log(`could not read ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 1_000);
    this.persistTimer.unref();
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.entries()].map(([hash, record]) => ({ hash, ...record })),
    };
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, this.statePath);
    } catch (error) {
      log(`could not save OAuth state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of this.pending) if (entry.expires < now) this.pending.delete(key);
    for (const [key, entry] of this.codes) if (entry.expires < now) this.codes.delete(key);
    for (const [key, entry] of this.tokens) {
      if (entry.expires < now) {
        this.tokens.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of this.cimdCache) if (entry.expires < now) this.cimdCache.delete(key);
    if (changed) this.schedulePersist();
  }
}
