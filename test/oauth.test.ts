/**
 * Kakao Login test: runs the built server with a fake Kakao OAuth server, drives the
 * MCP SDK client through discovery → dynamic registration → authorization → PKCE token
 * exchange, and checks the allow list, token refresh/revocation, persistence and the
 * 401 challenge. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { startFixtureServer } from './fixture-server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KAKAO_CLIENT_ID = 'test-rest-api-key';
const KAKAO_CLIENT_SECRET = 'test-client-secret';
const STATIC_TOKEN = 'static-token-0123456789abcdef';

interface KakaoUser {
  id: number;
  nickname: string;
  email?: string;
}

interface RecordedRequest {
  path: string;
  params: Record<string, string>;
}

function step(name: string): void {
  console.log(`• ${name}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A stand-in for kauth.kakao.com / kapi.kakao.com that approves whoever `setUser` names. */
async function startFakeKakao(): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  setUser(user: KakaoUser): void;
  close(): Promise<void>;
}> {
  let current: KakaoUser = { id: 0, nickname: 'nobody' };
  const codes = new Map<string, KakaoUser>();
  const accessTokens = new Map<string, KakaoUser>();
  const requests: RecordedRequest[] = [];
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      if (url.searchParams.get('client_id') !== KAKAO_CLIENT_ID || url.searchParams.get('response_type') !== 'code') {
        redirect.searchParams.set('error', 'invalid_request');
        redirect.searchParams.set('error_description', 'bad client');
      } else {
        const code = `kakao-code-${++counter}`;
        codes.set(code, current);
        redirect.searchParams.set('code', code);
      }
      const state = url.searchParams.get('state');
      if (state) redirect.searchParams.set('state', state);
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const form = await readForm(req);
      requests.push({ path: url.pathname, params: Object.fromEntries(form) });
      const user = codes.get(form.get('code') ?? '');
      if (form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== KAKAO_CLIENT_ID || form.get('client_secret') !== KAKAO_CLIENT_SECRET || !user) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'bad token request', error_code: 'KOE320' }));
        return;
      }
      codes.delete(form.get('code')!);
      const accessToken = `kakao-access-${++counter}`;
      accessTokens.set(accessToken, user);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          token_type: 'bearer',
          access_token: accessToken,
          expires_in: 21599,
          refresh_token: `kakao-refresh-${counter}`,
          refresh_token_expires_in: 5183999,
        }),
      );
      return;
    }
    if (url.pathname === '/v2/user/me') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const user = token ? accessTokens.get(token) : undefined;
      if (!user) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ msg: 'this access token does not exist', code: -401 }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: user.id,
          connected_at: '2026-01-01T00:00:00Z',
          properties: {},
          kakao_account: {
            profile_nickname_needs_agreement: false,
            profile: { nickname: user.nickname },
            has_email: Boolean(user.email),
            email_needs_agreement: false,
            ...(user.email ? { is_email_valid: true, is_email_verified: true, email: user.email } : {}),
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    setUser: (user) => {
      current = user;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The client's redirect target: records whatever the authorization server sends back. */
async function startCallbackServer(): Promise<{ url: string; next(): Promise<URLSearchParams>; close(): Promise<void> }> {
  const waiters: Array<(params: URLSearchParams) => void> = [];
  const queue: URLSearchParams[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    const waiter = waiters.shift();
    if (waiter) waiter(url.searchParams);
    else queue.push(url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/callback`,
    next: () => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Acts as the person's browser: follows every redirect until a page answers. */
async function browse(startUrl: string): Promise<{ status: number; url: string; body: string }> {
  let url = startUrl;
  for (let hop = 0; hop < 10; hop++) {
    const response = await fetch(url, { redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.text();
      url = new URL(location, url).toString();
      continue;
    }
    return { status: response.status, url, body: await response.text() };
  }
  throw new Error('too many redirects');
}

class TestProvider implements OAuthClientProvider {
  clientInfo?: StoredOAuthClientInformation;
  storedTokens?: StoredOAuthTokens;
  verifier?: string;
  authUrl?: URL;
  discovery?: OAuthDiscoveryState;

  constructor(readonly redirectUrl: string) {}

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: 'browser-mcp oauth test',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return randomBytes(8).toString('hex');
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.clientInfo;
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    this.clientInfo = info;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.storedTokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.storedTokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no code verifier saved');
    return this.verifier;
  }
}

interface ServerHandle {
  proc: ChildProcess;
  stderr: string[];
  stop(): Promise<number | null>;
}

async function startServer(args: string[], env: Record<string, string>): Promise<ServerHandle> {
  const proc = spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js'), '--http', ...args], {
    cwd: projectRoot,
    env: { ...process.env, BROWSER_MCP_TOKENS: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr.join('')}`)), 30_000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.push(text);
      if (/listening on http/.test(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${stderr.join('')}`));
    });
  });
  return {
    proc,
    stderr,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) {
          resolve(proc.exitCode);
          return;
        }
        proc.once('exit', (code) => resolve(code));
        proc.kill('SIGTERM');
      }),
  };
}

/** Logs in through the SDK's own OAuth flow and returns a connected client. */
async function loginWithSdk(
  mcpUrl: string,
  provider: TestProvider,
  callback: { next(): Promise<URLSearchParams> },
): Promise<{ client: Client; params: URLSearchParams }> {
  const first = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  const probe = new Client({ name: 'browser-mcp-oauth-test', version: '0.0.0' });
  await assert.rejects(probe.connect(first), (error) => UnauthorizedError.isInstance(error) || /unauthorized/i.test(String(error)));
  assert.ok(provider.authUrl, 'the client was sent to the authorization endpoint');
  assert.ok(provider.clientInfo?.client_id, 'the client registered itself dynamically');

  const page = await browse(provider.authUrl.toString());
  assert.equal(page.status, 200, page.body);
  const params = await callback.next();
  if (params.get('error')) return { client: probe, params };
  assert.equal(params.get('state'), provider.authUrl.searchParams.get('state'), 'state round-trips');
  await first.finishAuth(params.get('code')!);

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), { authProvider: provider });
  const client = new Client({ name: 'browser-mcp-oauth-test', version: '0.0.0' });
  await client.connect(transport);
  return { client, params };
}

async function rawInitialize(mcpUrl: string, accessToken: string): Promise<Response> {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    }),
  });
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST', body: new URLSearchParams(form) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  const kakao = await startFakeKakao();
  const callback = await startCallbackServer();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-mcp-oauth-'));
  const dataDir = path.join(tempRoot, 'data');
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const mcpUrl = `${publicUrl}/mcp`;
  const serverArgs = [
    '--port', String(port),
    '--public-url', publicUrl,
    '--kakao-client-id', KAKAO_CLIENT_ID,
    '--kakao-scope', 'account_email',
    '--allowed-users', '1001, bob@example.com',
    '--allow-private-network',
    '--data-dir', dataDir,
  ];
  const serverEnv = {
    BROWSER_MCP_KAKAO_CLIENT_SECRET: KAKAO_CLIENT_SECRET,
    BROWSER_MCP_KAKAO_AUTHORIZE_URL: `${kakao.baseUrl}/oauth/authorize`,
    BROWSER_MCP_KAKAO_TOKEN_URL: `${kakao.baseUrl}/oauth/token`,
    BROWSER_MCP_KAKAO_USERINFO_URL: `${kakao.baseUrl}/v2/user/me`,
    BROWSER_MCP_TOKENS: `${STATIC_TOKEN}:staticuser`,
  };
  let server = await startServer(serverArgs, serverEnv);

  try {
    step('discovery documents point clients at the Kakao-backed authorization server');
    const prm = (await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(prm.resource, mcpUrl);
    assert.deepEqual(prm.authorization_servers, [publicUrl]);
    const metadata = (await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(metadata.issuer, publicUrl);
    assert.equal(metadata.registration_endpoint, `${publicUrl}/register`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);

    step('an unauthenticated request gets a 401 challenge with the resource metadata URL');
    const challenge = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(challenge.status, 401);
    const header = challenge.headers.get('www-authenticate') ?? '';
    assert.match(header, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' }, body: '{}' });
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get('www-authenticate') ?? '', /error="invalid_token"/);

    step('an allowed Kakao account logs in through the SDK flow and can browse');
    kakao.setUser({ id: 1001, nickname: 'Alice' });
    const alice = new TestProvider(callback.url);
    const { client: aliceClient } = await loginWithSdk(mcpUrl, alice, callback);
    assert.equal((await aliceClient.listTools()).tools.length, 22);
    const nav = (await aliceClient.callTool({ name: 'browser_navigate', arguments: { url: fixture.baseUrl } })) as { isError?: boolean };
    assert.equal(nav.isError, undefined, 'navigation succeeded');
    assert.ok(alice.storedTokens?.access_token && alice.storedTokens.refresh_token, 'tokens were issued');
    const profile = JSON.parse(await readFile(path.join(dataDir, 'users', 'kakao-1001', 'profile.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(profile.nickname, 'Alice');
    const tokenRequest = kakao.requests.find((request) => request.path === '/oauth/token');
    assert.equal(tokenRequest?.params.client_secret, KAKAO_CLIENT_SECRET, 'the client secret was sent to Kakao');
    assert.equal(tokenRequest?.params.redirect_uri, `${publicUrl}/oauth/kakao/callback`);
    const authorizeRequest = kakao.requests.find((request) => request.path === '/oauth/authorize');
    assert.equal(authorizeRequest?.params.scope, 'account_email');
    await aliceClient.close();

    step('/mcp/lite is a second protected resource with the chat tool set');
    const litePrm = (await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp/lite`)).json()) as Record<string, unknown>;
    assert.equal(litePrm.resource, `${mcpUrl}/lite`);
    const liteChallenge = await fetch(`${mcpUrl}/lite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(liteChallenge.status, 401);
    assert.match(liteChallenge.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp\/lite"/);
    // Discovery is open on /mcp/lite, so the handshake succeeds without a login...
    const aliceLite = new TestProvider(callback.url);
    const liteTransport = new StreamableHTTPClientTransport(new URL(`${mcpUrl}/lite`), { authProvider: aliceLite });
    const liteProbe = new Client({ name: 'browser-mcp-oauth-test', version: '0.0.0' });
    await liteProbe.connect(liteTransport);
    assert.equal((await liteProbe.listTools()).tools.length, 14);
    // ...and the first tool call is what sends the client through Kakao Login.
    await assert.rejects(
      liteProbe.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }),
      (error) => UnauthorizedError.isInstance(error) || /unauthorized/i.test(String(error)),
    );
    assert.ok(aliceLite.authUrl, 'the 401 on the tool call sent the client to the authorization endpoint');
    const litePage = await browse(aliceLite.authUrl.toString());
    assert.equal(litePage.status, 200, litePage.body);
    const liteParams = await callback.next();
    assert.equal(liteParams.get('error'), null, liteParams.toString());
    await liteTransport.finishAuth(liteParams.get('code')!);
    const liteClient = new Client({ name: 'browser-mcp-oauth-test', version: '0.0.0' });
    await liteClient.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/lite`), { authProvider: aliceLite }));
    const liteTabs = (await liteClient.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })) as { isError?: boolean };
    assert.equal(liteTabs.isError, undefined, 'tool calls work after the login');
    await liteClient.close();
    await liteProbe.close().catch(() => undefined);

    step('a Kakao account outside the allow list is refused with its id in the error');
    kakao.setUser({ id: 2002, nickname: 'Mallory', email: 'mallory@example.com' });
    const mallory = new TestProvider(callback.url);
    const denied = await loginWithSdk(mcpUrl, mallory, callback);
    assert.equal(denied.params.get('error'), 'access_denied');
    assert.match(denied.params.get('error_description') ?? '', /2002/);
    assert.ok(server.stderr.join('').includes('login denied'), 'the refusal was logged');

    step('an account allowed by e-mail logs in');
    kakao.setUser({ id: 3003, nickname: 'Bob', email: 'Bob@Example.com' });
    const bob = new TestProvider(callback.url);
    const { client: bobClient } = await loginWithSdk(mcpUrl, bob, callback);
    assert.equal((await bobClient.listTools()).tools.length, 22);
    await bobClient.close();
    await readFile(path.join(dataDir, 'users', 'kakao-3003', 'profile.json'), 'utf8');

    step('static tokens keep working next to Kakao login');
    const staticInit = await rawInitialize(mcpUrl, STATIC_TOKEN);
    assert.equal(staticInit.status, 200);
    assert.ok(staticInit.headers.get('mcp-session-id'));
    await staticInit.text();

    step('refresh tokens rotate and retire the previous access token');
    const oldAccess = alice.storedTokens!.access_token;
    const oldRefresh = alice.storedTokens!.refresh_token!;
    const refreshed = await postForm(`${publicUrl}/token`, {
      grant_type: 'refresh_token',
      refresh_token: oldRefresh,
      client_id: alice.clientInfo!.client_id,
    });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.ok(refreshed.body.access_token && refreshed.body.refresh_token);
    const reused = await postForm(`${publicUrl}/token`, { grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: alice.clientInfo!.client_id });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, 'invalid_grant');
    assert.equal((await rawInitialize(mcpUrl, oldAccess)).status, 401);
    const newAccess = refreshed.body.access_token as string;
    const fresh = await rawInitialize(mcpUrl, newAccess);
    assert.equal(fresh.status, 200);
    await fresh.text();

    step('revoked tokens stop working');
    const revoked = await fetch(`${publicUrl}/revoke`, { method: 'POST', body: new URLSearchParams({ token: newAccess }) });
    assert.equal(revoked.status, 200);
    assert.equal((await rawInitialize(mcpUrl, newAccess)).status, 401);

    step('dynamic registration rejects non-loopback http redirect URIs');
    const badRegistration = await fetch(`${publicUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'] }),
    });
    assert.equal(badRegistration.status, 400);
    assert.equal(((await badRegistration.json()) as Record<string, unknown>).error, 'invalid_redirect_uri');

    step('a wrong PKCE verifier is rejected');
    kakao.setUser({ id: 1001, nickname: 'Alice' });
    const registration = (await (
      await fetch(`${publicUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [callback.url], client_name: 'manual' }),
      })
    ).json()) as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const authorizeUrl = new URL(`${publicUrl}/authorize`);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', registration.client_id);
    authorizeUrl.searchParams.set('redirect_uri', callback.url);
    authorizeUrl.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'manual-state');
    authorizeUrl.searchParams.set('resource', mcpUrl);
    await browse(authorizeUrl.toString());
    const manual = await callback.next();
    assert.equal(manual.get('state'), 'manual-state');
    const wrongVerifier = await postForm(`${publicUrl}/token`, {
      grant_type: 'authorization_code',
      code: manual.get('code')!,
      client_id: registration.client_id,
      redirect_uri: callback.url,
      code_verifier: 'not-the-verifier',
    });
    assert.equal(wrongVerifier.status, 400);
    assert.equal(wrongVerifier.body.error, 'invalid_grant');

    step('tokens and registrations survive a server restart');
    const bobAccess = bob.storedTokens!.access_token;
    assert.equal(await server.stop(), 0);
    server = await startServer(serverArgs, serverEnv);
    const afterRestart = await rawInitialize(mcpUrl, bobAccess);
    assert.equal(afterRestart.status, 200);
    await afterRestart.text();
    assert.ok(server.stderr.join('').includes('loaded'), 'persisted state was loaded');

    step('Kakao login requires a public URL');
    await assert.rejects(
      startServer(['--port', '0', '--kakao-client-id', KAKAO_CLIENT_ID], { BROWSER_MCP_KAKAO_CLIENT_SECRET: 'x' }),
      /--public-url is required/,
    );

    console.log('\nAll Kakao login tests passed.');
  } finally {
    await server.stop();
    await Promise.all([fixture.close(), kakao.close(), callback.close()]);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
