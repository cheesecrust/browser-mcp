import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { TokenStore } from './auth.js';
import { BrowserSession, type Workspace } from './browser.js';
import type { Config } from './config.js';
import { HandoffManager } from './handoff.js';
import { log } from './log.js';
import { SecretLinkManager, Vault } from './vault.js';
import { OAuthServer, type OAuthOutcome } from './oauth.js';
import { UrlGuard } from './policy.js';
import { createServer, LITE_TOOLS, type ToolProfile } from './server.js';
import type { ToolCallInfo } from './tools/common.js';

/**
 * Remote mode. The bearer token (a static token or a Kakao Login access token)
 * identifies the user, and every user gets one browser that all of their MCP
 * sessions and session-less requests share:
 * - a POST initialize without Mcp-Session-Id opens a session (Claude Code, Codex,
 *   Cursor and other stateful clients);
 * - any other POST without Mcp-Session-Id is answered statelessly against the same
 *   browser (gateways that do not keep sessions, such as PlayMCP);
 * - the browser closes after --idle-timeout without tool calls and relaunches with
 *   the user's saved state on the next call.
 * /mcp serves every tool; /mcp/lite serves the chat-oriented subset. Both paths are
 * OAuth protected resources (see RESOURCE_PATHS in oauth.ts).
 */

const PROFILES: Readonly<Record<string, ToolProfile>> = { '/mcp': 'full', '/mcp/lite': 'lite' };
const PROTECTED_RESOURCE_PREFIX = '/.well-known/oauth-protected-resource';
const MAX_FORM_BYTES = 64 * 1024;
const MAX_MCP_BYTES = 4 * 1024 * 1024;
/** JSON-RPC methods that reveal nothing but the tool catalogue; /mcp/lite answers them without a token. */
const DISCOVERY_METHODS: ReadonlySet<string> = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list']);
const short = (id: string): string => id.slice(0, 8);

interface UserEntry {
  user: string;
  browser: BrowserSession;
  lastActivity: number;
  /** Ids of the open MCP sessions that use this browser. */
  sessions: Set<string>;
}

interface SessionEntry {
  id: string;
  user: string;
  profile: ToolProfile;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  lastActivity: number;
  closing: boolean;
}

interface Principal {
  user: string;
  display?: string | undefined;
}

export interface HttpServerHandle {
  host: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

class Registry {
  private readonly users = new Map<string, UserEntry>();
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly handoffs: HandoffManager) {}

  get sessionCount(): number {
    return this.sessions.size;
  }

  get userCount(): number {
    return this.users.size;
  }

  get browserCount(): number {
    let count = 0;
    for (const entry of this.users.values()) if (entry.browser.running) count++;
    return count;
  }

  user(name: string): UserEntry | undefined {
    return this.users.get(name);
  }

  addUser(entry: UserEntry): void {
    this.users.set(entry.user, entry);
  }

  session(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  addSession(entry: SessionEntry): void {
    this.sessions.set(entry.id, entry);
    this.users.get(entry.user)?.sessions.add(entry.id);
  }

  /** The least recently active open session of a user. */
  oldestSessionOf(user: string): SessionEntry | undefined {
    let oldest: SessionEntry | undefined;
    for (const entry of this.sessions.values()) {
      if (entry.user === user && !entry.closing && (!oldest || entry.lastActivity < oldest.lastActivity)) oldest = entry;
    }
    return oldest;
  }

  /** The least recently active user without open sessions, whose browser can make room. */
  evictableUser(): UserEntry | undefined {
    let oldest: UserEntry | undefined;
    for (const entry of this.users.values()) {
      if (entry.sessions.size === 0 && (!oldest || entry.lastActivity < oldest.lastActivity)) oldest = entry;
    }
    return oldest;
  }

  idleSessions(maxIdleMs: number): SessionEntry[] {
    const cutoff = Date.now() - maxIdleMs;
    return [...this.sessions.values()].filter((entry) => entry.lastActivity < cutoff);
  }

  idleUsers(maxIdleMs: number): UserEntry[] {
    const cutoff = Date.now() - maxIdleMs;
    return [...this.users.values()].filter((entry) => entry.lastActivity < cutoff && (entry.browser.running || entry.sessions.size === 0));
  }

  async closeSession(id: string, reason: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry || entry.closing) return;
    entry.closing = true;
    this.sessions.delete(id);
    this.users.get(entry.user)?.sessions.delete(id);
    log(`session ${short(id)} (${entry.user}) closed: ${reason}`);
    await entry.transport.close().catch(() => undefined);
  }

  /** Closes a user's browser (saving its state). The entry stays while sessions still point at it. */
  async closeBrowser(entry: UserEntry, reason: string): Promise<void> {
    if (entry.browser.running) {
      log(`browser of ${entry.user} closed: ${reason}`);
      await this.handoffs.closeFor(entry.browser);
      await entry.browser.mutex.run(() => entry.browser.close());
    }
    if (entry.sessions.size === 0 && this.users.get(entry.user) === entry) this.users.delete(entry.user);
  }

  async closeAll(reason: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id, reason)));
    await Promise.all([...this.users.values()].map((entry) => this.closeBrowser(entry, reason)));
  }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, mcp-protocol-version',
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendOutcome(res: ServerResponse, outcome: OAuthOutcome): void {
  switch (outcome.kind) {
    case 'redirect':
      res.writeHead(302, { location: outcome.location, 'cache-control': 'no-store' });
      res.end();
      return;
    case 'json':
      sendJson(res, outcome.status, outcome.body, { ...CORS_HEADERS, 'cache-control': 'no-store', pragma: 'no-cache' });
      return;
    case 'html':
      res.writeHead(outcome.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(outcome.body);
  }
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

async function readRaw(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads a small OAuth request body as JSON or form data. */
async function readBody(req: IncomingMessage): Promise<URLSearchParams | unknown> {
  const text = await readRaw(req, MAX_FORM_BYTES);
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('application/json')) return text ? (JSON.parse(text) as unknown) : {};
  return new URLSearchParams(text);
}

/** Reads an MCP request body; the transport gets it pre-parsed so the stream is read once. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRaw(req, MAX_MCP_BYTES);
  return text.trim() ? (JSON.parse(text) as unknown) : {};
}

function methodsOf(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .map((message) => (message && typeof message === 'object' ? (message as { method?: unknown }).method : undefined))
    .filter((method): method is string => typeof method === 'string');
}

function isInitialize(body: unknown): boolean {
  return methodsOf(body).includes('initialize');
}

function isDiscoveryOnly(body: unknown): boolean {
  const methods = methodsOf(body);
  return methods.length > 0 && methods.every((method) => DISCOVERY_METHODS.has(method));
}

/**
 * The SDK transport insists on `Accept: application/json, text/event-stream`. Simple
 * gateways send only application/json (or nothing), so fix the header up for them and
 * answer with plain JSON instead of an event stream. Returns true for JSON mode.
 */
function negotiateJson(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? '';
  const wantsStream = accept.includes('text/event-stream');
  if (!wantsStream || !accept.includes('application/json')) setHeader(req, 'accept', 'application/json, text/event-stream');
  return !wantsStream;
}

/** Rewrites a request header in both views Node offers; the transport builds its Request from rawHeaders. */
function setHeader(req: IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === name) {
      raw[i + 1] = value;
      found = true;
    }
  }
  if (!found) raw.push(name, value);
}

function asForm(body: URLSearchParams | unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  const params = new URLSearchParams();
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string') params.set(key, value);
    }
  }
  return params;
}

function withAuth(req: IncomingMessage, authInfo: AuthInfo): void {
  (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
}

export async function startHttpServer(config: Config): Promise<HttpServerHandle> {
  const tokens = new TokenStore(config.tokens);
  const oauth = config.kakaoClientId
    ? new OAuthServer({
        publicUrl: config.publicUrl!,
        dataDir: config.dataDir,
        kakao: {
          clientId: config.kakaoClientId,
          clientSecret: config.kakaoClientSecret,
          scope: config.kakaoScope,
          ...config.kakaoEndpoints,
        },
        allowedUsers: config.allowedUsers,
        accessTokenTtlMs: config.accessTokenTtlMs,
        refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1_000,
        clients: config.oauthClients,
      })
    : undefined;
  const unauthenticated = tokens.size === 0 && !oauth;
  const guard = config.allowPrivateNetwork ? undefined : new UrlGuard();
  const handoffs = new HandoffManager({ publicUrl: config.publicUrl });
  const vault = new Vault(config.dataDir, config.vaultKey);
  const secrets = new SecretLinkManager(vault, { publicUrl: config.publicUrl });
  const registry = new Registry(handoffs);
  const creating = new Map<string, Promise<UserEntry | undefined>>();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  await mkdir(config.dataDir, { recursive: true });
  await vault.init();
  if (oauth) await oauth.start();

  async function createBrowserSession(user: string): Promise<BrowserSession> {
    const root = path.join(config.dataDir, 'users', user);
    const workspace: Workspace = {
      root,
      downloads: path.join(root, 'downloads'),
      files: path.join(root, 'files'),
      screenshots: path.join(root, 'screenshots'),
    };
    await Promise.all(Object.values(workspace).map((dir) => mkdir(dir, { recursive: true })));
    return new BrowserSession(config, { workspace, storageStatePath: path.join(root, 'storage-state.json'), guard });
  }

  /** The user's browser entry, created on first use; undefined when the server is full. */
  async function ensureUser(principal: Principal): Promise<UserEntry | undefined> {
    const { user } = principal;
    const existing = registry.user(user);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }
    const pending = creating.get(user);
    if (pending) return pending;
    const task = (async (): Promise<UserEntry | undefined> => {
      if (registry.userCount >= config.maxSessions) {
        const victim = registry.evictableUser();
        if (!victim) return undefined;
        await registry.closeBrowser(victim, `browser limit (${config.maxSessions}) reached`);
      }
      const entry: UserEntry = { user, browser: await createBrowserSession(user), lastActivity: Date.now(), sessions: new Set() };
      registry.addUser(entry);
      log(`workspace ready for ${user}${principal.display ? ` (${principal.display})` : ''}`);
      return entry;
    })();
    creating.set(user, task);
    try {
      return await task;
    } finally {
      creating.delete(user);
    }
  }

  /** The origin the caller reached us at, for links handed to people (behind Caddy: the forwarded scheme and host). */
  function originOf(req: IncomingMessage): string {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() || 'http';
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  function toolCallLogger(entry: UserEntry, sessionLabel: () => string): (info: ToolCallInfo) => void {
    return (info) => {
      entry.lastActivity = Date.now();
      log(`user=${entry.user} session=${sessionLabel()} tool=${info.name} ok=${info.ok} ms=${info.ms}${info.url ? ` url=${info.url}` : ''}`);
    };
  }

  /** Identifies the caller from the Authorization header: static token first, then an OAuth access token. */
  function authenticate(authorization: string | undefined, apiKey: string | undefined): Principal | undefined {
    if (unauthenticated) return { user: 'local' };
    // Static tokens: "Authorization: Bearer <token>", a bare Authorization value, or X-API-Key (gateways with fixed header forms).
    const staticUser = tokens.authenticate(authorization) ?? (apiKey ? tokens.userFor(apiKey.trim()) : undefined);
    if (staticUser) return { user: staticUser };
    if (oauth) {
      const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
      const user = match ? oauth.verifyAccessToken(match[1]!) : undefined;
      if (user) return { user: user.user, display: user.nickname };
    }
    return undefined;
  }

  function challenge(res: ServerResponse, tokenPresented: boolean, resourcePath: string): void {
    const parts = ['Bearer realm="browser-mcp"'];
    if (tokenPresented) parts.push('error="invalid_token"', 'error_description="The access token is missing, expired or revoked"');
    if (oauth) parts.push(`resource_metadata="${oauth.protectedResourceMetadataUrl(resourcePath)}"`);
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': parts.join(', ') });
  }

  function serverFull(res: ServerResponse): void {
    sendJson(res, 503, rpcError(-32000, 'The server is at its browser limit; try again later'));
  }

  /** POST initialize without a session id: opens a session bound to the user's browser. */
  async function openSession(
    principal: Principal,
    authInfo: AuthInfo,
    profile: ToolProfile,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const user = await ensureUser(principal);
    if (!user) {
      serverFull(res);
      return;
    }
    while (user.sessions.size >= config.maxSessionsPerUser) {
      const victim = registry.oldestSessionOf(user.user);
      if (!victim) break;
      await registry.closeSession(victim.id, `per-user session limit (${config.maxSessionsPerUser}) reached`);
    }

    const now = Date.now();
    const entry: SessionEntry = {
      id: '',
      user: user.user,
      profile,
      transport: undefined as unknown as NodeStreamableHTTPServerTransport,
      createdAt: now,
      lastActivity: now,
      closing: false,
    };
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: negotiateJson(req),
      onsessioninitialized: (id) => {
        entry.id = id;
        registry.addSession(entry);
        log(`session ${short(id)} opened for ${user.user}${principal.display ? ` (${principal.display})` : ''} (${profile})`);
      },
      onsessionclosed: (id) => void registry.closeSession(id, 'closed by client'),
    });
    entry.transport = transport;

    const mcp = createServer(user.browser, {
      remote: true,
      profile,
      onToolCall: toolCallLogger(user, () => short(entry.id)),
      handoff: handoffs.brokerFor(user.user, user.browser, originOf(req)),
      credentials: secrets.brokerFor(user.user, originOf(req)),
    });
    mcp.server.onclose = () => {
      if (entry.id) void registry.closeSession(entry.id, 'transport closed');
    };
    await mcp.connect(transport);

    withAuth(req, authInfo);
    await transport.handleRequest(req, res, body);
    // The transport answered with an error instead of opening a session: nothing to keep.
    if (!entry.id) await transport.close().catch(() => undefined);
  }

  /** A POST without a session id that is not initialize: answered against the user's browser, then forgotten. */
  async function serveStateless(
    principal: Principal,
    authInfo: AuthInfo,
    profile: ToolProfile,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const user = await ensureUser(principal);
    if (!user) {
      serverFull(res);
      return;
    }
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: negotiateJson(req) });
    const mcp = createServer(user.browser, {
      remote: true,
      profile,
      onToolCall: toolCallLogger(user, () => 'none'),
      handoff: handoffs.brokerFor(user.user, user.browser, originOf(req)),
      credentials: secrets.brokerFor(user.user, originOf(req)),
    });
    await mcp.connect(transport);
    res.once('close', () => void transport.close().catch(() => undefined));
    withAuth(req, authInfo);
    await transport.handleRequest(req, res, body);
  }

  /**
   * The tool catalogue for callers without any token: PlayMCP's console reads it when a
   * server is registered, before anyone has logged in. No tool runs here, so the
   * browser session is never launched.
   */
  async function serveDiscovery(profile: ToolProfile, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: negotiateJson(req) });
    // The catalogue must match what a logged-in user gets, so the hand-over tool is listed too (it never runs here).
    const probe = new BrowserSession(config, { guard });
    const mcp = createServer(probe, {
      remote: true,
      profile,
      handoff: handoffs.brokerFor('anonymous', probe, originOf(req)),
      credentials: secrets.brokerFor('anonymous', originOf(req)),
    });
    await mcp.connect(transport);
    res.once('close', () => void transport.close().catch(() => undefined));
    await transport.handleRequest(req, res, body);
  }

  async function handleOAuth(pathname: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!oauth) return false;
    const method = req.method ?? 'GET';
    const resourcePath =
      pathname === PROTECTED_RESOURCE_PREFIX
        ? '/mcp'
        : pathname.startsWith(`${PROTECTED_RESOURCE_PREFIX}/`)
          ? pathname.slice(PROTECTED_RESOURCE_PREFIX.length)
          : undefined;
    const isOAuthPath =
      resourcePath !== undefined ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/register' ||
      pathname === '/authorize' ||
      pathname === '/oauth/kakao/callback' ||
      pathname === '/token' ||
      pathname === '/revoke';
    if (!isOAuthPath) return false;
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }
    if (resourcePath !== undefined) {
      if (!(resourcePath in PROFILES)) sendJson(res, 404, { error: 'not found' });
      else sendJson(res, 200, oauth.protectedResourceMetadata(resourcePath), CORS_HEADERS);
      return true;
    }
    switch (pathname) {
      case '/.well-known/oauth-authorization-server':
        sendJson(res, 200, oauth.authorizationServerMetadata(), CORS_HEADERS);
        return true;
      case '/register':
        if (method !== 'POST') break;
        sendOutcome(res, oauth.register(await readBody(req)));
        return true;
      case '/authorize':
        if (method !== 'GET') break;
        sendOutcome(res, await oauth.authorize(url.searchParams));
        return true;
      case '/oauth/kakao/callback':
        if (method !== 'GET') break;
        sendOutcome(res, await oauth.kakaoCallback(url.searchParams));
        return true;
      case '/token':
        if (method !== 'POST') break;
        sendOutcome(res, oauth.token(asForm(await readBody(req)), req.headers.authorization));
        return true;
      case '/revoke':
        if (method !== 'POST') break;
        sendOutcome(res, oauth.revoke(asForm(await readBody(req))));
        return true;
    }
    res.writeHead(405, { allow: pathname === '/authorize' || pathname === '/oauth/kakao/callback' ? 'GET' : 'POST' });
    res.end();
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname === '/healthz') {
      sendJson(res, 200, {
        ok: true,
        sessions: registry.sessionCount,
        browsers: registry.browserCount,
        uptime: Math.round(process.uptime()),
      });
      return;
    }
    if (await handleOAuth(pathname, req, res, url)) return;
    // Hand-over pages are reached by people with a link, not by MCP clients with a token.
    if (await handoffs.handle(pathname, req, res)) return;
    if (await secrets.handle(pathname, req, res)) return;
    const profile = PROFILES[pathname];
    if (!profile) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (unauthenticated && (!validateHost(req, res) || !validateOrigin(req, res))) return;

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, rpcError(-32700, `Parse error: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
    }
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    const apiKeyHeader = req.headers['x-api-key'];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    const principal = authenticate(req.headers.authorization, apiKey);
    if (!principal) {
      if (profile === 'lite' && !req.headers.authorization && !apiKey && req.method === 'POST' && !sessionId && isDiscoveryOnly(body)) {
        await serveDiscovery(profile, req, res, body);
        return;
      }
      challenge(res, Boolean(req.headers.authorization || apiKey), pathname);
      return;
    }
    const { user } = principal;
    const authInfo: AuthInfo = { token: 'opaque', clientId: user, scopes: ['browser'], extra: { user, display: principal.display } };

    if (sessionId) {
      const entry = registry.session(sessionId);
      if (!entry || entry.user !== user) {
        sendJson(res, 404, rpcError(-32001, 'Session not found'));
        return;
      }
      const now = Date.now();
      entry.lastActivity = now;
      const owner = registry.user(user);
      if (owner) owner.lastActivity = now;
      negotiateJson(req);
      withAuth(req, authInfo);
      await entry.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 400, rpcError(-32000, 'Bad Request: an Mcp-Session-Id header is required for GET and DELETE'));
      return;
    }
    if (isInitialize(body)) await openSession(principal, authInfo, profile, req, res, body);
    else await serveStateless(principal, authInfo, profile, req, res, body);
  }

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      log(`request error: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal error'));
      else res.end();
    });
  });

  const sweepEvery = Math.min(30_000, Math.max(500, Math.floor(config.idleTimeoutMs / 2)));
  const sweeper = setInterval(() => {
    for (const entry of registry.idleSessions(config.idleTimeoutMs)) void registry.closeSession(entry.id, 'idle timeout');
    for (const entry of registry.idleUsers(config.idleTimeoutMs)) void registry.closeBrowser(entry, 'idle timeout');
  }, sweepEvery);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const hostForUrl = config.host.includes(':') ? `[${config.host}]` : config.host;
  const authDescription = unauthenticated
    ? 'no authentication, loopback only'
    : [oauth ? 'Kakao login' : undefined, tokens.size ? `${tokens.size} static token(s)` : undefined].filter(Boolean).join(' + ');
  log(
    `listening on http://${hostForUrl}:${port}/mcp (${authDescription}, ${guard ? 'public web only' : 'private network allowed'}, ` +
      `idle timeout ${Math.round(config.idleTimeoutMs / 1000)}s, data in ${config.dataDir}); /mcp/lite serves the ${LITE_TOOLS.size}-tool chat subset`,
  );

  let closing: Promise<void> | undefined;
  return {
    host: config.host,
    port,
    sessionCount: () => registry.sessionCount,
    close: () => {
      closing ??= (async () => {
        clearInterval(sweeper);
        await handoffs.close();
        secrets.close();
        await registry.closeAll('server shutting down');
        if (oauth) await oauth.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
