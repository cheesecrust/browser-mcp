/**
 * Remote-mode test: starts the built server in HTTP mode, connects with the SDK's
 * Streamable HTTP client as different users, and checks authentication, session
 * isolation, per-user persistence, workspace confinement, the network policy,
 * idle cleanup and shutdown. Run with `npm test`.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startFixtureServer } from './fixture-server.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALICE = 'alice-token-0123456789abcdef';
const BOB = 'bob-token-0123456789abcdef';
const TOKENS = `${ALICE}:alice,${BOB}:bob`;

interface ServerHandle {
  proc: ChildProcess;
  url: string;
  stderr: string[];
  stop(): Promise<number | null>;
}

interface CallOutcome {
  text: string;
  isError: boolean;
}

interface Session {
  client: Client;
  transport: StreamableHTTPClientTransport;
  call(name: string, args?: Record<string, unknown>): Promise<CallOutcome>;
}

function step(name: string): void {
  console.log(`• ${name}`);
}

async function startServer(args: string[], env: Record<string, string>): Promise<ServerHandle> {
  const proc = spawn(process.execPath, [path.join(projectRoot, 'dist', 'index.js'), '--http', '--port', '0', ...args], {
    cwd: projectRoot,
    env: { ...process.env, BROWSER_MCP_TOKENS: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr: string[] = [];
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${stderr.join('')}`)), 30_000);
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.push(text);
      const match = /listening on (http:\/\/\S+\/mcp)/.exec(text);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with code ${code}:\n${stderr.join('')}`));
    });
  });
  const stop = (): Promise<number | null> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
        return;
      }
      proc.once('exit', (code) => resolve(code));
      proc.kill('SIGTERM');
    });
  return { proc, url, stderr, stop };
}

async function connect(url: string, token?: string): Promise<Session> {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: 'browser-mcp-http-test', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    return { text, isError: result.isError === true };
  };
  return { client, transport, call };
}

async function health(url: string): Promise<{ ok: boolean; sessions: number; browsers: number }> {
  const response = await fetch(new URL('/healthz', url));
  assert.equal(response.status, 200);
  return (await response.json()) as { ok: boolean; sessions: number; browsers: number };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(200);
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-mcp-http-'));
  const servers: ServerHandle[] = [];
  const dataDir = (name: string): string => path.join(tempRoot, name);

  try {
    // ---- server A: authenticated, private network allowed so the fixture is reachable ----
    const a = await startServer(['--allow-private-network', '--data-dir', dataDir('a'), '--idle-timeout', '120', '--max-sessions-per-user', '3'], {
      BROWSER_MCP_TOKENS: TOKENS,
    });
    servers.push(a);

    step('requests without a valid token are rejected with 401');
    const anonymous = await fetch(a.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{}',
    });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', /Bearer/);
    await assert.rejects(connect(a.url), /unauthorized|401/);
    await assert.rejects(connect(a.url, 'wrong-token-0123456789abcdef'), /unauthorized|401/);
    assert.equal((await health(a.url)).sessions, 0);

    step('an authenticated client gets the full tool set and remote instructions');
    let alice = await connect(a.url, ALICE);
    const tools = await alice.client.listTools();
    assert.equal(tools.tools.length, 22);
    assert.match(alice.client.getInstructions() ?? '', /shared remote server/);
    assert.ok(alice.transport.sessionId, 'server assigned a session id');

    step('two users browse at the same time without sharing state');
    const nav = await alice.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(nav.isError, false, nav.text);
    assert.match(nav.text, /Navigated to/);
    const setCookie = await alice.call('browser_evaluate', {
      expression: 'document.cookie = "who=alice; max-age=3600"; document.cookie',
    });
    assert.match(setCookie.text, /who=alice/);

    const bob = await connect(a.url, BOB);
    const bobNav = await bob.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(bobNav.isError, false, bobNav.text);
    const bobCookie = await bob.call('browser_evaluate', { expression: 'document.cookie' });
    assert.doesNotMatch(bobCookie.text, /who=alice/);
    assert.equal((await health(a.url)).sessions, 2);
    assert.equal((await health(a.url)).browsers, 2);

    step('sessions of the same user share one browser; closing a session keeps it');
    const alice2 = await connect(a.url, ALICE);
    const sharedTabs = await alice2.call('browser_tabs', { action: 'list' });
    assert.match(sharedTabs.text, new RegExp(escapeRegExp(fixture.baseUrl)));
    assert.equal((await health(a.url)).browsers, 2, 'no extra browser for the second session');
    await alice2.transport.terminateSession();
    await waitFor(async () => (await health(a.url)).sessions === 2, 10_000, 'second alice session to close');
    const stillOpen = await alice.call('browser_snapshot', {});
    assert.equal(stillOpen.isError, false, stillOpen.text);

    step('requests without a session id are served statelessly against the same browser');
    const stateless = await fetch(a.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ALICE}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } }),
    });
    assert.equal(stateless.status, 200);
    assert.equal(stateless.headers.get('mcp-session-id'), null, 'no session is created');
    const statelessText = await stateless.text();
    assert.ok(statelessText.includes(fixture.baseUrl), `the stateless call saw alice's tab:\n${statelessText}`);
    assert.equal((await health(a.url)).sessions, 2);

    step('/mcp/lite exposes the chat subset without screenshots');
    const lite = await connect(`${a.url}/lite`, ALICE);
    const liteTools = (await lite.client.listTools()).tools;
    const liteNames = liteTools.map((tool) => tool.name);
    assert.equal(liteNames.length, 14);
    assert.ok(liteNames.includes('browser_click') && liteNames.includes('browser_navigate'));
    assert.ok(!liteNames.includes('browser_screenshot') && !liteNames.includes('browser_evaluate') && !liteNames.includes('browser_file_upload'));
    assert.ok(
      liteTools.every((tool) => tool.annotations?.title && typeof tool.annotations.readOnlyHint === 'boolean'),
      'every tool carries a title and hints in its annotations',
    );
    assert.match(lite.client.getInstructions() ?? '', /chat subset/);
    const liteTabs = await lite.call('browser_tabs', { action: 'list' });
    assert.match(liteTabs.text, new RegExp(escapeRegExp(fixture.baseUrl)), 'the lite session uses the same browser');
    await lite.transport.terminateSession();
    await waitFor(async () => (await health(a.url)).sessions === 2, 10_000, 'lite session to close');

    step('/mcp/lite answers tool discovery without a token, in plain JSON, but refuses tool calls');
    const rpc = (method: string, params?: unknown): string => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const anonymousPost = (url: string, payload: string): Promise<Response> =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: payload });
    const anonList = await anonymousPost(`${a.url}/lite`, rpc('tools/list'));
    assert.equal(anonList.status, 200);
    assert.match(anonList.headers.get('content-type') ?? '', /application\/json/);
    const anonTools = (await anonList.json()) as { result?: { tools?: Array<{ name: string }> } };
    assert.equal(anonTools.result?.tools?.length, 14);
    const anonInit = await anonymousPost(
      `${a.url}/lite`,
      rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'anonymous', version: '0' } }),
    );
    assert.equal(anonInit.status, 200);
    assert.equal(anonInit.headers.get('mcp-session-id'), null, 'discovery opens no session');
    const anonCall = await anonymousPost(`${a.url}/lite`, rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } }));
    assert.equal(anonCall.status, 401);
    assert.equal((await anonymousPost(a.url, rpc('tools/list'))).status, 401, 'the full endpoint still needs a token');
    assert.equal((await health(a.url)).browsers, 2, 'discovery launched no browser');

    step('a session cannot be used with another user\'s token');
    const stolen = await fetch(a.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${BOB}`,
        'mcp-session-id': alice.transport.sessionId ?? '',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(stolen.status, 404);

    step('file paths are confined to the user workspace');
    const shot = await alice.call('browser_screenshot', { savePath: 'shots/first.png' });
    assert.equal(shot.isError, false, shot.text);
    assert.match(shot.text, /saved to screenshots\/shots\/first\.png/);
    await stat(path.join(dataDir('a'), 'users', 'alice', 'screenshots', 'shots', 'first.png'));
    const outside = await alice.call('browser_screenshot', { savePath: '/tmp/browser-mcp-escape.png' });
    assert.equal(outside.isError, true);
    assert.match(outside.text, /workspace/);
    const escape = await alice.call('browser_screenshot', { savePath: '../../escape.png' });
    assert.equal(escape.isError, true);

    await writeFile(path.join(dataDir('a'), 'users', 'alice', 'files', 'hello.txt'), 'hello');
    const upload = await alice.call('browser_file_upload', { selector: '#file', paths: ['hello.txt'] });
    assert.equal(upload.isError, false, upload.text);
    assert.match(upload.text, /hello\.txt/);
    const hostsUpload = await alice.call('browser_file_upload', { selector: '#file', paths: ['/etc/hosts'] });
    assert.equal(hostsUpload.isError, true);
    assert.match(hostsUpload.text, /workspace/);

    step('closing the browser saves the user state; the next session gets it back');
    const closed = await alice.call('browser_close', {});
    assert.equal(closed.isError, false, closed.text);
    await alice.transport.terminateSession();
    await waitFor(async () => (await health(a.url)).sessions === 1, 10_000, 'alice session to close');
    const statePath = path.join(dataDir('a'), 'users', 'alice', 'storage-state.json');
    await waitFor(() => stat(statePath).then(() => true, () => false), 10_000, 'storage state file');
    assert.match(await readFile(statePath, 'utf8'), /who=alice|"who"/);

    alice = await connect(a.url, ALICE);
    const again = await alice.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(again.isError, false, again.text);
    const restored = await alice.call('browser_evaluate', { expression: 'document.cookie' });
    assert.match(restored.text, /who=alice/);
    assert.doesNotMatch(bobCookie.text, /who=alice/);

    step('beyond the per-user session limit the least recently used session is closed');
    const extra = [await connect(a.url, ALICE), await connect(a.url, ALICE)];
    assert.equal((await health(a.url)).sessions, 4);
    const fourth = await connect(a.url, ALICE);
    assert.equal((await health(a.url)).sessions, 4, 'the oldest alice session was closed to make room');
    await assert.rejects(alice.call('browser_snapshot', {}), /404|Session not found/);
    const fourthTabs = await fourth.call('browser_tabs', { action: 'list' });
    assert.equal(fourthTabs.isError, false, fourthTabs.text);
    for (const session of [...extra, fourth]) await session.transport.terminateSession();
    await waitFor(async () => (await health(a.url)).sessions === 1, 10_000, 'extra sessions to close');
    alice = await connect(a.url, ALICE);

    step('SIGTERM closes every browser and exits cleanly');
    const exitCode = await a.stop();
    assert.equal(exitCode, 0, `stderr:\n${a.stderr.join('')}`);
    await alice.client.close().catch(() => undefined);
    await bob.client.close().catch(() => undefined);

    // ---- server B: default network policy (public web only) ----
    const b = await startServer(['--data-dir', dataDir('b')], { BROWSER_MCP_TOKENS: TOKENS });
    servers.push(b);
    const carol = await connect(b.url, ALICE);

    step('private addresses, local names and file URLs are refused');
    const privateNav = await carol.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(privateNav.isError, true);
    assert.match(privateNav.text, /private or reserved address/);
    const fileNav = await carol.call('browser_navigate', { url: 'file:///etc/hosts' });
    assert.equal(fileNav.isError, true);
    assert.match(fileNav.text, /not allowed/);
    const localNav = await carol.call('browser_navigate', { url: 'http://localhost:1/' });
    assert.equal(localNav.isError, true);
    assert.match(localNav.text, /local address/);
    const newTab = await carol.call('browser_tabs', { action: 'new', url: 'http://169.254.169.254/latest/meta-data/' });
    assert.equal(newTab.isError, true);

    step('sub-resource requests to private addresses are blocked');
    const dataPage = await carol.call('browser_navigate', {
      url: `data:text/html,<img id="img" src="${fixture.baseUrl}/x.png">`,
    });
    assert.equal(dataPage.isError, false, dataPage.text);
    await sleep(500);
    const requests = await carol.call('browser_network_requests', {});
    assert.match(requests.text, /x\.png/);
    assert.match(requests.text, /ERR_BLOCKED_BY_CLIENT|blocked/i);
    assert.ok(b.stderr.join('').includes('blocked'), 'server logged the blocked request');
    await carol.client.close().catch(() => undefined);
    await b.stop();

    // ---- server C: idle timeout ----
    const c = await startServer(['--allow-private-network', '--idle-timeout', '2', '--data-dir', dataDir('c')], {
      BROWSER_MCP_TOKENS: TOKENS,
    });
    servers.push(c);

    step('idle sessions are closed and later calls fail clearly');
    const dave = await connect(c.url, ALICE);
    const daveNav = await dave.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(daveNav.isError, false, daveNav.text);
    await waitFor(async () => (await health(c.url)).sessions === 0, 10_000, 'idle session to close');
    await waitFor(async () => (await health(c.url)).browsers === 0, 10_000, 'idle browser to close');
    await assert.rejects(dave.call('browser_snapshot', {}), /404|Session not found/);
    await dave.client.close().catch(() => undefined);
    await c.stop();

    // ---- server D: unauthenticated loopback test server ----
    const d = await startServer(['--allow-unauthenticated', '--allow-private-network', '--data-dir', dataDir('d')], {});
    servers.push(d);

    step('an unauthenticated loopback server accepts local clients');
    const local = await connect(d.url);
    assert.equal((await local.client.listTools()).tools.length, 22);
    const localNavigate = await local.call('browser_navigate', { url: fixture.baseUrl });
    assert.equal(localNavigate.isError, false, localNavigate.text);
    await local.client.close().catch(() => undefined);
    await d.stop();

    step('refusing to start without tokens on a non-loopback address');
    await assert.rejects(startServer(['--host', '0.0.0.0', '--allow-unauthenticated'], {}), /loopback/);

    console.log('\nAll HTTP mode tests passed.');
  } finally {
    await Promise.all(servers.map((server) => server.stop()));
    await fixture.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
