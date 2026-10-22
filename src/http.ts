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
import { UrlGuard } from './policy.js';
import { createServer } from './server.js';

/**
 * Remote mode: one MCP session (Mcp-Session-Id) per connected client, each with its
 * own browser, bound to the user that the bearer token identifies.
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

export interface HttpServerHandle {
  host: string;
  port: number;
  sessionCount(): number;
  close(): Promise<void>;
}

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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(code: number, message: string): unknown {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}

export async function startHttpServer(config: Config): Promise<HttpServerHandle> {
  const tokens = new TokenStore(config.tokens);
  const unauthenticated = tokens.size === 0;
  const guard = config.allowPrivateNetwork ? undefined : new UrlGuard();
  const registry = new SessionRegistry();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  await mkdir(config.dataDir, { recursive: true });

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

  async function openSession(user: string, authInfo: AuthInfo, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const entry: SessionEntry = { id: '', user, transport: undefined as unknown as NodeStreamableHTTPServerTransport, browser, createdAt: now, lastActivity: now, closing: false };
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        entry.id = id;
        registry.add(entry);
        log(`session ${short(id)} opened for ${user}`);
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, sessions: registry.size, uptime: Math.round(process.uptime()) });
      return;
    }
    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (unauthenticated && (!validateHost(req, res) || !validateOrigin(req, res))) return;

    const user = unauthenticated ? 'local' : tokens.authenticate(req.headers.authorization);
    if (!user) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="browser-mcp"' });
      return;
    }
    const authInfo: AuthInfo = { token: 'static', clientId: user, scopes: [], extra: { user } };

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
    await openSession(user, authInfo, req, res);
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
  log(
    `listening on http://${hostForUrl}:${port}/mcp (${unauthenticated ? 'no authentication, loopback only' : `${tokens.size} user token(s)`}, ` +
      `${guard ? 'public web only' : 'private network allowed'}, idle timeout ${Math.round(config.idleTimeoutMs / 1000)}s, data in ${config.dataDir})`,
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
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
