import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { localhostHostValidation, localhostOriginValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { TokenStore } from './auth.js';
import { BrowserSession, type Workspace } from './browser.js';
import type { Config } from './config.js';
import { log } from './log.js';
import { OAuthServer, type OAuthOutcome } from './oauth.js';
import { UrlGuard } from './policy.js';
import { createServer } from './server.js';

/**
 * Remote mode: one MCP session (Mcp-Session-Id) per connected client, each with its
 * own browser, bound to the user that the bearer token identifies. Users are
 * identified by static tokens, by Kakao Login (OAuth), or not at all on a
 * loopback-only test server.
 */

interface SessionEntry {
  id: string;
  user: string;
  transport: NodeStreamableHTTPServerTransport;
  browser: BrowserSession;
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

const MAX_BODY_BYTES = 64 * 1024;
const short = (id: string): string => id.slice(0, 8);

class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();

  get size(): number {
    return this.sessions.size;
  }

  countFor(user: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) if (entry.user === user) count++;
    return count;
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  add(entry: SessionEntry): void {
    this.sessions.set(entry.id, entry);
  }

  idle(maxIdleMs: number): SessionEntry[] {
    const cutoff = Date.now() - maxIdleMs;
    return [...this.sessions.values()].filter((entry) => entry.lastActivity < cutoff);
  }

  async close(id: string, reason: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry || entry.closing) return;
    entry.closing = true;
    this.sessions.delete(id);
    log(`session ${short(id)} (${entry.user}) closed: ${reason}`);
    await entry.browser.close();
    await entry.transport.close().catch(() => undefined);
  }

  async closeAll(reason: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, reason)));
  }
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
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

/** Reads a small request body as JSON or form data. */
async function readBody(req: IncomingMessage): Promise<URLSearchParams | unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('application/json')) return text ? (JSON.parse(text) as unknown) : {};
  return new URLSearchParams(text);
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
      })
    : undefined;
  const unauthenticated = tokens.size === 0 && !oauth;
  const guard = config.allowPrivateNetwork ? undefined : new UrlGuard();
  const registry = new SessionRegistry();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  await mkdir(config.dataDir, { recursive: true });
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

  /** Identifies the caller from the Authorization header: static token first, then an OAuth access token. */
  function authenticate(authorization: string | undefined): Principal | undefined {
    if (unauthenticated) return { user: 'local' };
    const staticUser = tokens.authenticate(authorization);
    if (staticUser) return { user: staticUser };
    if (oauth) {
      const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
      const user = match ? oauth.verifyAccessToken(match[1]!) : undefined;
      if (user) return { user: user.user, display: user.nickname };
    }
    return undefined;
  }

  function challenge(res: ServerResponse, tokenPresented: boolean): void {
    const parts = ['Bearer realm="browser-mcp"'];
    if (tokenPresented) parts.push('error="invalid_token"', 'error_description="The access token is missing, expired or revoked"');
    if (oauth) parts.push(`resource_metadata="${oauth.protectedResourceMetadataUrl}"`);
    sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': parts.join(', ') });
  }

  async function openSession(principal: Principal, authInfo: AuthInfo, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { user } = principal;
    if (registry.size >= config.maxSessions) {
      sendJson(res, 503, rpcError(-32000, 'The server is at its session limit; try again later'));
      return;
    }
    const open = registry.countFor(user);
    if (open >= config.maxSessionsPerUser) {
      sendJson(
        res,
        429,
        rpcError(
          -32000,
          `You already have ${open} open session(s). Close one (HTTP DELETE /mcp with its Mcp-Session-Id) or wait for the idle timeout.`,
        ),
      );
      return;
    }

    const browser = await createBrowserSession(user);
    const now = Date.now();
    const entry: SessionEntry = {
      id: '',
      user,
      transport: undefined as unknown as NodeStreamableHTTPServerTransport,
      browser,
      createdAt: now,
      lastActivity: now,
      closing: false,
    };
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        entry.id = id;
        registry.add(entry);
        log(`session ${short(id)} opened for ${user}${principal.display ? ` (${principal.display})` : ''}`);
      },
      onsessionclosed: (id) => void registry.close(id, 'closed by client'),
    });
    entry.transport = transport;

    const mcp = createServer(browser, {
      remote: true,
      onToolCall: (info) =>
        log(`user=${user} session=${short(entry.id)} tool=${info.name} ok=${info.ok} ms=${info.ms}${info.url ? ` url=${info.url}` : ''}`),
    });
    mcp.server.onclose = () => {
      if (entry.id) void registry.close(entry.id, 'transport closed');
      else void browser.close();
    };
    await mcp.connect(transport);

    (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
    await transport.handleRequest(req, res);
    if (!entry.id) {
      // Not an initialize request (the transport answered with an error): nothing to keep.
      await transport.close().catch(() => undefined);
      await browser.close();
    }
  }

  async function handleOAuth(pathname: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!oauth) return false;
    const method = req.method ?? 'GET';
    const isOAuthPath =
      pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-protected-resource/mcp' ||
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
    switch (pathname) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        sendJson(res, 200, oauth.protectedResourceMetadata(), CORS_HEADERS);
        return true;
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
        sendOutcome(res, oauth.token(asForm(await readBody(req))));
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
      sendJson(res, 200, { ok: true, sessions: registry.size, uptime: Math.round(process.uptime()) });
      return;
    }
    if (await handleOAuth(pathname, req, res, url)) return;
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (unauthenticated && (!validateHost(req, res) || !validateOrigin(req, res))) return;

    const principal = authenticate(req.headers.authorization);
    if (!principal) {
      challenge(res, Boolean(req.headers.authorization));
      return;
    }
    const { user } = principal;
    const authInfo: AuthInfo = { token: 'opaque', clientId: user, scopes: ['browser'], extra: { user, display: principal.display } };

    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const entry = registry.get(sessionId);
      if (!entry || entry.user !== user) {
        sendJson(res, 404, rpcError(-32001, 'Session not found'));
        return;
      }
      entry.lastActivity = Date.now();
      (req as IncomingMessage & { auth?: AuthInfo }).auth = authInfo;
      await entry.transport.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 400, rpcError(-32000, 'Bad Request: an Mcp-Session-Id header is required'));
      return;
    }
    await openSession(principal, authInfo, req, res);
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
    for (const entry of registry.idle(config.idleTimeoutMs)) void registry.close(entry.id, 'idle timeout');
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
      `idle timeout ${Math.round(config.idleTimeoutMs / 1000)}s, data in ${config.dataDir})`,
  );

  let closing: Promise<void> | undefined;
  return {
    host: config.host,
    port,
    sessionCount: () => registry.size,
    close: () => {
      closing ??= (async () => {
        clearInterval(sweeper);
        await registry.closeAll('server shutting down');
        if (oauth) await oauth.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
