import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CDPSession, Page } from 'playwright';
import { Mutex, type BrowserSession } from './browser.js';
import { log } from './log.js';

/**
 * Hand-over to a person. The agent asks for a link; the person opens it, sees the
 * live browser screen and drives it with their own mouse and keyboard (log in,
 * solve a CAPTCHA, pass a "are you human" check), then presses 완료. Cookies set
 * while they drive stay in the user's browser, so the agent continues logged in.
 *
 * The link carries a random code and nothing else: it works without a token,
 * only for the browser it was made for, and only until it expires or is finished.
 * Frames come from Chromium's screencast (or screenshots on other engines) over
 * Server-Sent Events; input goes back as small JSON posts.
 */

export const HANDOFF_PATH = '/view';
const DEFAULT_MINUTES = 10;
const MAX_MINUTES = 30;
const MAX_VIEWERS = 3;
const MAX_EVENTS_PER_POST = 200;
const MAX_TEXT_LENGTH = 2_000;
const MAX_INPUT_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 500;
const STATUS_INTERVAL_MS = 2_000;
const KEEPALIVE_MS = 15_000;

export type HandoffState = 'active' | 'finished' | 'expired' | 'closed';

export interface HandoffSummary {
  url: string;
  state: HandoffState;
  createdAt: number;
  expiresAt: number;
  finishedAt?: number | undefined;
  reason?: string | undefined;
}

export interface HandoffOptions {
  reason?: string | undefined;
  minutes?: number | undefined;
}

/** What a tool gets to create or inspect the hand-over of its browser. */
export interface HandoffBroker {
  open(options: HandoffOptions): HandoffSummary;
  current(): HandoffSummary | undefined;
}

type InputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; key: string }
  | { t: 'text'; text: string };

interface Frame {
  data: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function unit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function parseEvent(raw: unknown): InputEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const event = raw as Record<string, unknown>;
  switch (event.t) {
    case 'move':
    case 'down':
    case 'up': {
      const x = unit(event.x);
      const y = unit(event.y);
      if (x === undefined || y === undefined) return undefined;
      if (event.t === 'move') return { t: 'move', x, y };
      const button = event.button === 'middle' || event.button === 'right' ? event.button : 'left';
      return { t: event.t, x, y, button };
    }
    case 'wheel': {
      const x = unit(event.x);
      const y = unit(event.y);
      const dx = typeof event.dx === 'number' && Number.isFinite(event.dx) ? Math.max(-2_000, Math.min(2_000, event.dx)) : 0;
      const dy = typeof event.dy === 'number' && Number.isFinite(event.dy) ? Math.max(-2_000, Math.min(2_000, event.dy)) : 0;
      if (x === undefined || y === undefined) return undefined;
      return { t: 'wheel', x, y, dx, dy };
    }
    case 'key':
      return typeof event.key === 'string' && event.key.length > 0 && event.key.length <= 48 ? { t: 'key', key: event.key } : undefined;
    case 'text':
      return typeof event.text === 'string' && event.text.length > 0 && event.text.length <= MAX_TEXT_LENGTH
        ? { t: 'text', text: event.text }
        : undefined;
    default:
      return undefined;
  }
}

class Handoff {
  readonly code = randomBytes(24).toString('base64url');
  readonly createdAt = Date.now();
  expiresAt: number;
  finishedAt?: number;
  state: HandoffState = 'active';
  private readonly viewers = new Set<ServerResponse>();
  private lastFrame?: Frame;
  private screencast?: { page: Page; cdp?: CDPSession; poll?: NodeJS.Timeout; stopping?: Promise<void> };
  private statusTimer?: NodeJS.Timeout;
  private readonly input = new Mutex();
  private lastStatus = '';

  constructor(
    readonly user: string,
    readonly session: BrowserSession,
    readonly reason: string | undefined,
    minutes: number,
  ) {
    this.expiresAt = this.createdAt + minutes * 60_000;
  }

  summary(baseUrl: string): HandoffSummary {
    return {
      url: `${baseUrl}${HANDOFF_PATH}/${this.code}`,
      state: this.state,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      finishedAt: this.finishedAt,
      reason: this.reason,
    };
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** Streams frames and status to one browser tab of the person. */
  addViewer(res: ServerResponse): void {
    if (this.viewers.size >= MAX_VIEWERS) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Too many viewers for this link.');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.viewers.add(res);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    keepalive.unref();
    res.once('close', () => {
      clearInterval(keepalive);
      this.viewers.delete(res);
      if (this.viewers.size === 0) void this.stopScreencast();
    });
    this.lastStatus = '';
    this.sendStatus();
    if (this.lastFrame) this.send(res, 'frame', this.lastFrame.data);
    void this.ensureScreencast();
    if (!this.statusTimer) {
      this.statusTimer = setInterval(() => {
        if (this.viewers.size === 0) {
          clearInterval(this.statusTimer);
          this.statusTimer = undefined;
          return;
        }
        this.sendStatus();
        void this.ensureScreencast();
      }, STATUS_INTERVAL_MS);
      this.statusTimer.unref();
    }
  }

  private send(res: ServerResponse, event: string, data: string): void {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  }

  private broadcast(event: string, data: string): void {
    for (const res of this.viewers) this.send(res, event, data);
  }

  private sendStatus(): void {
    const page = this.state === 'active' ? this.session.currentPage() : undefined;
    const dialog = page ? this.session.dialogFor(page) : undefined;
    const status = JSON.stringify({
      state: this.state,
      expiresAt: this.expiresAt,
      reason: this.reason ?? null,
      url: page?.url() ?? null,
      dialog: dialog ? { type: dialog.type(), message: dialog.message() } : null,
      engine: this.session.config.browser,
    });
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.broadcast('status', status);
  }

  /** Captures the active tab; re-attaches when the agent or the person switches tabs. */
  private async ensureScreencast(): Promise<void> {
    if (this.state !== 'active' || this.viewers.size === 0) return;
    const page = this.session.currentPage();
    if (!page) return;
    if (this.screencast?.page === page) return;
    await this.stopScreencast();
    const entry: NonNullable<typeof this.screencast> = { page };
    this.screencast = entry;
    const viewport = page.viewportSize() ?? this.session.config.viewport;
    if (this.session.config.browser === 'chromium') {
      try {
        const cdp = await page.context().newCDPSession(page);
        entry.cdp = cdp;
        cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
          cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
          if (this.screencast !== entry) return;
          this.lastFrame = { data: frame.data };
          this.broadcast('frame', frame.data);
        });
        await cdp.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 70,
          maxWidth: viewport.width,
          maxHeight: viewport.height,
          everyNthFrame: 1,
        });
        return;
      } catch (error) {
        log(`hand-over ${this.user}: screencast unavailable, falling back to screenshots (${error instanceof Error ? error.message : String(error)})`);
        entry.cdp = undefined;
      }
    }
    // Other engines (or a failed screencast): poll screenshots while someone watches.
    let busy = false;
    const poll = async (): Promise<void> => {
      if (busy || this.screencast !== entry || page.isClosed() || this.session.dialogFor(page)) return;
      busy = true;
      try {
        const buffer = await page.screenshot({ type: 'jpeg', quality: 70, timeout: POLL_INTERVAL_MS * 4 });
        const data = buffer.toString('base64');
        if (this.lastFrame?.data !== data) {
          this.lastFrame = { data };
          this.broadcast('frame', data);
        }
      } catch {
        // A navigation or a closed page; the next tick tries again.
      } finally {
        busy = false;
      }
    };
    entry.poll = setInterval(() => void poll(), POLL_INTERVAL_MS);
    entry.poll.unref();
    void poll();
  }

  private async stopScreencast(): Promise<void> {
    const entry = this.screencast;
    if (!entry) return;
    this.screencast = undefined;
    if (entry.poll) clearInterval(entry.poll);
    if (entry.cdp) {
      await entry.cdp.send('Page.stopScreencast').catch(() => undefined);
      await entry.cdp.detach().catch(() => undefined);
    }
  }

  /** Replays the person's mouse and keyboard on the active tab, in order. */
  async applyInput(events: InputEvent[]): Promise<{ applied: number; note?: string }> {
    return this.input.run(async () => {
      if (this.state !== 'active') return { applied: 0, note: 'This hand-over has ended.' };
      const page = this.session.currentPage();
      if (!page) return { applied: 0, note: 'The browser has no open tab.' };
      if (this.session.dialogFor(page)) return { applied: 0, note: 'A dialog is open; answer it first.' };
      const viewport = page.viewportSize() ?? this.session.config.viewport;
      let applied = 0;
      for (const event of events) {
        try {
          switch (event.t) {
            case 'move':
              await page.mouse.move(event.x * viewport.width, event.y * viewport.height);
              break;
            case 'down':
              await page.mouse.move(event.x * viewport.width, event.y * viewport.height);
              await page.mouse.down({ button: event.button });
              break;
            case 'up':
              await page.mouse.move(event.x * viewport.width, event.y * viewport.height);
              await page.mouse.up({ button: event.button });
              break;
            case 'wheel':
              await page.mouse.move(event.x * viewport.width, event.y * viewport.height);
              await page.mouse.wheel(event.dx, event.dy);
              break;
            case 'key':
              await page.keyboard.press(event.key);
              break;
            case 'text':
              await page.keyboard.insertText(event.text);
              break;
          }
          applied++;
        } catch {
          // Unknown key names and actions during navigation are dropped; the person simply retries.
        }
        if (this.session.dialogFor(page)) break;
      }
      this.session.schedulePersist();
      return { applied };
    });
  }

  async answerDialog(accept: boolean, promptText?: string): Promise<string> {
    const page = this.session.currentPage();
    if (!page || !this.session.dialogFor(page)) return 'No dialog is open.';
    return this.session.handleDialog(page, accept, promptText);
  }

  /** Ends the hand-over; viewers see the final state and the link stops working. */
  async end(state: Exclude<HandoffState, 'active'>): Promise<void> {
    if (this.state !== 'active') return;
    this.state = state;
    this.finishedAt = Date.now();
    this.sendStatus();
    await this.stopScreencast();
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
    for (const res of this.viewers) res.end();
    this.viewers.clear();
    this.session.schedulePersist();
  }
}

export interface HandoffManagerOptions {
  /** Base URL for links, e.g. "https://browser.example.com"; without it the request's host is used. */
  publicUrl?: string | undefined;
}

export class HandoffManager {
  private readonly byCode = new Map<string, Handoff>();
  private readonly byBrowser = new Map<BrowserSession, Handoff>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: HandoffManagerOptions = {}) {
    this.sweeper = setInterval(() => void this.sweep(), 5_000);
    this.sweeper.unref();
  }

  /** The broker a tool uses for one user's browser. `baseUrl` is the origin the person reaches the server at. */
  brokerFor(user: string, session: BrowserSession, baseUrl: string): HandoffBroker {
    const base = (this.options.publicUrl ?? baseUrl).replace(/\/+$/, '');
    return {
      open: (options) => this.open(user, session, options).summary(base),
      current: () => this.byBrowser.get(session)?.summary(base),
    };
  }

  private open(user: string, session: BrowserSession, options: HandoffOptions): Handoff {
    const existing = this.byBrowser.get(session);
    if (existing?.state === 'active' && existing.expiresAt > Date.now()) return existing;
    if (existing) this.byCode.delete(existing.code);
    const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(options.minutes ?? DEFAULT_MINUTES)));
    const reason = options.reason?.trim().slice(0, 200) || undefined;
    const handoff = new Handoff(user, session, reason, minutes);
    this.byCode.set(handoff.code, handoff);
    this.byBrowser.set(session, handoff);
    log(`hand-over link created for ${user} (${minutes} min${reason ? `: ${reason}` : ''})`);
    return handoff;
  }

  /** Ends the hand-over of a browser that is being closed. */
  async closeFor(session: BrowserSession): Promise<void> {
    const handoff = this.byBrowser.get(session);
    if (!handoff) return;
    this.byBrowser.delete(session);
    this.byCode.delete(handoff.code);
    await handoff.end('closed');
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const handoff of this.byCode.values()) {
      if (handoff.state === 'active' && handoff.expiresAt <= now) {
        log(`hand-over link of ${handoff.user} expired`);
        await handoff.end('expired');
      }
      // Finished links are forgotten after a while so the code cannot be probed forever.
      if (handoff.state !== 'active' && (handoff.finishedAt ?? now) + 60_000 <= now) {
        this.byCode.delete(handoff.code);
        if (this.byBrowser.get(handoff.session) === handoff) this.byBrowser.delete(handoff.session);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.byCode.values()].map((handoff) => handoff.end('closed')));
    this.byCode.clear();
    this.byBrowser.clear();
  }

  /** Serves /view/<code>[/stream|/input|/dialog|/done]. Returns false when the path is not ours. */
  async handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (pathname !== HANDOFF_PATH && !pathname.startsWith(`${HANDOFF_PATH}/`)) return false;
    const [, code = '', action = ''] = pathname.slice(HANDOFF_PATH.length).split('/');
    const handoff = /^[A-Za-z0-9_-]{32}$/.test(code) ? this.byCode.get(code) : undefined;
    const method = req.method ?? 'GET';

    if (!handoff || (handoff.state !== 'active' && action === '')) {
      this.page(res, handoff ? 410 : 404, expiredPage(handoff?.state ?? 'expired'));
      return true;
    }
    switch (action) {
      case '':
        if (method !== 'GET' && method !== 'HEAD') return this.methodNotAllowed(res, 'GET');
        this.page(res, 200, viewerPage(handoff.reason));
        return true;
      case 'stream':
        if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
        handoff.addViewer(res);
        return true;
      case 'input': {
        if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
        const body = await readJson(req);
        const raw = body && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events) ? (body as { events: unknown[] }).events : [];
        const events = raw.slice(0, MAX_EVENTS_PER_POST).map(parseEvent).filter((event): event is InputEvent => event !== undefined);
        const outcome = await handoff.applyInput(events);
        this.json(res, 200, outcome);
        return true;
      }
      case 'dialog': {
        if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
        const body = (await readJson(req)) as { accept?: unknown; text?: unknown } | undefined;
        const note = await handoff.answerDialog(body?.accept === true, typeof body?.text === 'string' ? body.text.slice(0, MAX_TEXT_LENGTH) : undefined);
        this.json(res, 200, { note });
        return true;
      }
      case 'done':
        if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
        log(`hand-over of ${handoff.user} finished by the person`);
        await handoff.end('finished');
        this.json(res, 200, { state: handoff.state });
        return true;
      default:
        this.json(res, 404, { error: 'not found' });
        return true;
    }
  }

  private methodNotAllowed(res: ServerResponse, allow: string): boolean {
    res.writeHead(405, { allow });
    res.end();
    return true;
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private page(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'content-security-policy': "default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    });
    res.end(html);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f3f4f6; --fg: #111827; --muted: #6b7280; --card: #ffffff; --accent: #2563eb; --border: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #f3f4f6; --muted: #9ca3af; --card: #1c1f26; --accent: #60a5fa; --border: #2b2f3a; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; margin: 0; }
  header .reason { color: var(--muted); flex: 1 1 100%; }
  header .status { color: var(--muted); font-size: 13px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { padding: 12px 16px 24px; }
  .screen { position: relative; width: 100%; max-width: 1280px; margin: 0 auto; background: #000; border-radius: 8px; overflow: hidden; outline: none; touch-action: none; }
  .screen img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; }
  .screen .placeholder { color: #9ca3af; text-align: center; padding: 80px 16px; }
  .overlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,.55); padding: 16px; }
  .overlay.show { display: flex; }
  .dialog { background: var(--card); color: var(--fg); border-radius: 10px; padding: 16px; max-width: 420px; width: 100%; }
  .dialog p { margin: 0 0 12px; white-space: pre-wrap; }
  .dialog input { width: 100%; font: inherit; padding: 8px; margin-bottom: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--fg); }
  .dialog .row { display: flex; gap: 8px; justify-content: flex-end; }
  .hint { color: var(--muted); font-size: 13px; max-width: 1280px; margin: 10px auto 0; }
  .ended { text-align: center; padding: 60px 16px; }
  textarea.ime { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }
`;

function viewerPage(reason: string | undefined): string {
  const reasonHtml = reason ? `<div class="reason">${escapeHtml(reason)}</div>` : '';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>브라우저 직접 조작</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>브라우저 직접 조작</h1>
  <span class="status" id="status">연결 중…</span>
  <button class="primary" id="done">완료 (AI에게 돌려주기)</button>
  ${reasonHtml}
</header>
<main>
  <div class="screen" id="screen" tabindex="0">
    <div class="placeholder" id="placeholder">화면을 불러오는 중입니다…</div>
    <img id="frame" alt="" hidden>
    <div class="overlay" id="overlay"><div class="dialog">
      <p id="dialogMessage"></p>
      <input id="dialogText" hidden>
      <div class="row"><button id="dialogCancel">취소</button><button class="primary" id="dialogOk">확인</button></div>
    </div></div>
  </div>
  <p class="hint">화면을 클릭하고 입력하면 서버의 브라우저가 그대로 따라 합니다. 로그인이나 보안 문자를 마친 뒤 <b>완료</b>를 누르면 AI가 이어서 진행합니다. 비밀번호는 서버에 남지 않고 로그인 상태(쿠키)만 유지됩니다.</p>
</main>
<textarea class="ime" id="ime" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
<script>
(() => {
  const base = location.pathname.replace(/\\/+$/, '');
  const $ = (id) => document.getElementById(id);
  const screen = $('screen'), frame = $('frame'), placeholder = $('placeholder'), status = $('status');
  const overlay = $('overlay'), dialogMessage = $('dialogMessage'), dialogText = $('dialogText'), ime = $('ime');
  let state = 'active', expiresAt = 0, queue = [], sending = false, lastMove = 0, dialogOpen = false;

  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const flush = async () => {
    if (sending || queue.length === 0 || state !== 'active') return;
    sending = true;
    const events = queue.splice(0, 200);
    try { await post('/input', { events }); } catch {}
    sending = false;
    if (queue.length) flush();
  };
  const push = (event) => {
    if (state !== 'active' || dialogOpen) return;
    if (event.t === 'move') {
      const last = queue[queue.length - 1];
      if (last && last.t === 'move') { queue[queue.length - 1] = event; } else queue.push(event);
    } else queue.push(event);
    flush();
  };
  const pos = (clientX, clientY) => {
    const r = frame.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
    return { x, y };
  };
  const buttonName = (b) => (b === 1 ? 'middle' : b === 2 ? 'right' : 'left');

  screen.addEventListener('mousedown', (e) => {
    const p = pos(e.clientX, e.clientY); if (!p) return;
    e.preventDefault(); ime.focus({ preventScroll: true });
    push({ t: 'down', x: p.x, y: p.y, button: buttonName(e.button) });
  });
  screen.addEventListener('mouseup', (e) => {
    const p = pos(e.clientX, e.clientY); if (!p) return;
    e.preventDefault(); push({ t: 'up', x: p.x, y: p.y, button: buttonName(e.button) });
  });
  screen.addEventListener('mousemove', (e) => {
    const now = Date.now(); if (now - lastMove < 40) return; lastMove = now;
    const p = pos(e.clientX, e.clientY); if (p) push({ t: 'move', x: p.x, y: p.y });
  });
  screen.addEventListener('wheel', (e) => {
    const p = pos(e.clientX, e.clientY); if (!p) return;
    e.preventDefault(); push({ t: 'wheel', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
  }, { passive: false });
  screen.addEventListener('contextmenu', (e) => e.preventDefault());

  let touch = null;
  screen.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; const p = pos(t.clientX, t.clientY); if (!p) return;
    e.preventDefault(); touch = { x: t.clientX, y: t.clientY, p, moved: false };
  }, { passive: false });
  screen.addEventListener('touchmove', (e) => {
    if (!touch) return; const t = e.touches[0]; e.preventDefault();
    const dy = touch.y - t.clientY, dx = touch.x - t.clientX;
    if (Math.abs(dy) + Math.abs(dx) > 6) { touch.moved = true; push({ t: 'wheel', x: touch.p.x, y: touch.p.y, dx, dy }); touch.x = t.clientX; touch.y = t.clientY; }
  }, { passive: false });
  screen.addEventListener('touchend', (e) => {
    if (!touch) return; e.preventDefault();
    if (!touch.moved) { ime.focus({ preventScroll: true }); push({ t: 'down', x: touch.p.x, y: touch.p.y, button: 'left' }); push({ t: 'up', x: touch.p.x, y: touch.p.y, button: 'left' }); }
    touch = null;
  }, { passive: false });

  const SPECIAL = new Set(['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Insert','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12']);
  const onKey = (e) => {
    if (e.isComposing || e.key === 'Process') return;
    const mods = [];
    if (e.ctrlKey) mods.push('Control'); if (e.metaKey) mods.push('Meta'); if (e.altKey) mods.push('Alt');
    let key = null;
    if (SPECIAL.has(e.key)) key = e.key;
    else if (e.key === ' ') key = 'Space';
    else if (e.key.length === 1) key = e.key;
    if (!key) return;
    e.preventDefault();
    // Plain keys (including shifted characters such as "A" or "!") go as they are; shortcuts as "Control+a".
    if (mods.length === 0) { push({ t: 'key', key }); return; }
    if (e.key.length === 1 && /[a-z]/i.test(e.key)) key = e.key.toLowerCase();
    if (e.shiftKey) mods.push('Shift');
    push({ t: 'key', key: mods.join('+') + '+' + key });
  };
  ime.addEventListener('keydown', onKey);
  screen.addEventListener('keydown', onKey);
  ime.addEventListener('compositionend', (e) => { if (e.data) push({ t: 'text', text: e.data }); ime.value = ''; });
  ime.addEventListener('paste', (e) => { const text = (e.clipboardData || window.clipboardData).getData('text'); e.preventDefault(); if (text) push({ t: 'text', text }); });

  $('done').addEventListener('click', async () => {
    if (!confirm('AI에게 브라우저를 돌려줄까요?')) return;
    try { await post('/done', {}); } catch {}
    setState('finished');
  });
  $('dialogOk').addEventListener('click', () => post('/dialog', { accept: true, text: dialogText.hidden ? undefined : dialogText.value }));
  $('dialogCancel').addEventListener('click', () => post('/dialog', { accept: false }));

  const setState = (next) => {
    state = next;
    if (next === 'active') return;
    const text = next === 'finished' ? '완료했습니다. AI가 이어서 진행합니다. 이 창은 닫아도 됩니다.' : next === 'expired' ? '링크가 만료되었습니다. AI에게 새 링크를 요청하세요.' : '브라우저가 닫혔습니다. AI에게 새 링크를 요청하세요.';
    document.querySelector('main').innerHTML = '<div class="ended">' + text + '</div>';
    document.querySelector('header .status').textContent = '';
    $('done').hidden = true;
  };
  const tick = () => {
    if (state !== 'active') return;
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    status.textContent = '남은 시간 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
  };
  setInterval(tick, 1000);

  const connect = () => {
    const es = new EventSource(base + '/stream');
    es.addEventListener('frame', (e) => {
      frame.src = 'data:image/jpeg;base64,' + e.data; frame.hidden = false; placeholder.hidden = true;
    });
    es.addEventListener('status', (e) => {
      const s = JSON.parse(e.data);
      expiresAt = s.expiresAt; tick();
      dialogOpen = Boolean(s.dialog);
      overlay.classList.toggle('show', dialogOpen);
      if (s.dialog) { dialogMessage.textContent = (s.dialog.type === 'beforeunload' ? '페이지를 떠나시겠습니까?' : s.dialog.message || '(메시지 없음)'); dialogText.hidden = s.dialog.type !== 'prompt'; $('dialogCancel').hidden = s.dialog.type === 'alert'; }
      if (s.state !== 'active') { es.close(); setState(s.state); }
    });
    es.onerror = () => { if (state === 'active') status.textContent = '다시 연결 중…'; };
  };
  connect();
})();
</script>
</body>
</html>`;
}

function expiredPage(state: HandoffState): string {
  const text =
    state === 'finished'
      ? '이 링크는 이미 완료 처리되었습니다. 다시 필요하면 AI에게 새 링크를 요청하세요.'
      : '이 링크는 만료되었거나 존재하지 않습니다. AI에게 새 링크를 요청하세요.';
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>브라우저 직접 조작</title><style>${STYLE}</style></head>
<body><main><div class="ended">${text}</div></main></body></html>`;
}
