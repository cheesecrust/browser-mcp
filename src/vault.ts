import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { log } from './log.js';
import { isLocalHostname, isPrivateAddress } from './policy.js';

/**
 * Credential vault. A person stores a site login through a one-time link; the
 * agent only ever learns that an entry exists and can ask the server to type the
 * value into a field of a page on that site. The agent never sees the secret and
 * cannot send it to another site: the page's host must belong to the domain the
 * entry was saved for.
 *
 * Entries live in <data-dir>/users/<user>/credentials.json, each sealed with
 * AES-256-GCM under the server key (<data-dir>/vault.key, created on first use,
 * or BROWSER_MCP_VAULT_KEY). Losing the key loses the vault; nothing else does.
 */

export const SECRETS_PATH = '/secrets';
const LINK_MINUTES = 10;
const MAX_ENTRIES = 50;
const MAX_INPUT_BYTES = 64 * 1024;
const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const KEY_BYTES = 32;

export interface CredentialInfo {
  name: string;
  domain: string;
  /** The user name with most characters hidden, so the agent can tell accounts apart. */
  usernameHint: string;
  updatedAt: number;
}

export interface Credential {
  domain: string;
  username: string;
  password: string;
}

interface StoredEntry extends CredentialInfo {
  createdAt: number;
  /** base64(iv | tag | ciphertext) of JSON { username, password }. */
  sealed: string;
}

interface StoredFile {
  version: 1;
  entries: StoredEntry[];
}

export interface CredentialBroker {
  /** A link the person opens to add or remove logins of this user. */
  link(): { url: string; expiresAt: number };
  list(): Promise<CredentialInfo[]>;
  get(name: string): Promise<Credential | undefined>;
}

/** "naver.com" for "https://nid.naver.com/login", "127.0.0.1" for a loopback fixture. */
export function normalizeDomain(input: string): string | undefined {
  let value = input.trim().toLowerCase();
  if (!value) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return undefined;
  }
  hostname = hostname.replace(/\.$/, '');
  if (!hostname) return undefined;
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return hostname;
  return registrableDomain(hostname);
}

const SECOND_LEVEL = /^(co|com|net|org|go|ac|or|ne|re|pe|gov|edu|mil)$/;

/** "naver.com" for nid.naver.com, "daum.co.kr" for mail.daum.co.kr: the part a login is shared across. */
function registrableDomain(hostname: string): string {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const keep = labels[labels.length - 1]!.length === 2 && SECOND_LEVEL.test(labels[labels.length - 2]!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Whether a page at `url` may receive the credential saved for `domain`. */
export function hostMatches(url: string, domain: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'the active tab has no page open' };
  }
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  const bare = hostname.replace(/^\[|\]$/g, '');
  const isAddress = isIP(bare) !== 0;
  const local = isAddress ? isPrivateAddress(bare) : isLocalHostname(hostname);
  if (parsed.protocol !== 'https:' && !local) {
    return { ok: false, reason: `the page is not served over HTTPS (${parsed.origin}); a password is only typed into secure pages` };
  }
  const matches = isAddress ? hostname === domain : hostname === domain || hostname.endsWith(`.${domain}`);
  if (!matches) return { ok: false, reason: `the active tab is on ${hostname}, but this login was saved for ${domain}` };
  return { ok: true };
}

/** "naver" for naver.com, "daum" for daum.co.kr, the address itself for an IP. */
export function defaultName(domain: string): string {
  if (isIP(domain.replace(/^\[|\]$/g, ''))) return domain.replace(/[^a-z0-9]/g, '-');
  return domain.split('.')[0]!;
}

function usernameHint(username: string): string {
  const chars = [...username];
  if (chars.length <= 2) return `${chars[0] ?? ''}***`;
  return `${chars.slice(0, 2).join('')}***${chars.length > 6 ? chars.slice(-1).join('') : ''}`;
}

function parseKey(hex: string): Buffer {
  const value = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('the vault key must be 64 hex characters (32 bytes)');
  return Buffer.from(value, 'hex');
}

export class Vault {
  private key?: Buffer;
  private readonly files = new Map<string, Promise<StoredFile>>();

  constructor(
    private readonly dataDir: string,
    private readonly keyHex?: string,
  ) {}

  /** Loads the server key, creating one on first use. */
  async init(): Promise<void> {
    if (this.keyHex) {
      this.key = parseKey(this.keyHex);
      return;
    }
    const keyPath = path.join(this.dataDir, 'vault.key');
    try {
      this.key = parseKey(await readFile(keyPath, 'utf8'));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(this.dataDir, { recursive: true });
    const key = randomBytes(KEY_BYTES);
    await writeFile(keyPath, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      // Two servers starting at once: the other one wrote it first.
      if (error.code !== 'EEXIST') throw error;
    });
    this.key = parseKey(await readFile(keyPath, 'utf8'));
    log(`vault key stored in ${keyPath}`);
  }

  private filePath(user: string): string {
    return path.join(this.dataDir, 'users', user, 'credentials.json');
  }

  private async load(user: string): Promise<StoredFile> {
    let pending = this.files.get(user);
    if (!pending) {
      pending = readFile(this.filePath(user), 'utf8').then(
        (text) => {
          const data = JSON.parse(text) as StoredFile;
          return data && data.version === 1 && Array.isArray(data.entries) ? data : { version: 1, entries: [] };
        },
        () => ({ version: 1 as const, entries: [] }),
      );
      this.files.set(user, pending);
    }
    return pending;
  }

  private async store(user: string, file: StoredFile): Promise<void> {
    const target = this.filePath(user);
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(tmp, target);
    this.files.set(user, Promise.resolve(file));
  }

  private seal(user: string, name: string, secret: { username: string; password: string }): string {
    if (!this.key) throw new Error('vault not initialised');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${user}\0${name}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  private open(user: string, name: string, sealed: string): { username: string; password: string } {
    if (!this.key) throw new Error('vault not initialised');
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${user}\0${name}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return JSON.parse(body.toString('utf8')) as { username: string; password: string };
  }

  async list(user: string): Promise<CredentialInfo[]> {
    const file = await this.load(user);
    return file.entries.map(({ name, domain, usernameHint: hint, updatedAt }) => ({ name, domain, usernameHint: hint, updatedAt }));
  }

  async get(user: string, name: string): Promise<Credential | undefined> {
    const file = await this.load(user);
    const entry = file.entries.find((candidate) => candidate.name === name);
    if (!entry) return undefined;
    const secret = this.open(user, name, entry.sealed);
    return { domain: entry.domain, ...secret };
  }

  /** Adds or replaces an entry; returns the stored summary. */
  async save(user: string, input: { name?: string | undefined; domain: string; username: string; password: string }): Promise<CredentialInfo> {
    const domain = normalizeDomain(input.domain);
    if (!domain) throw new VaultError('사이트 주소가 올바르지 않습니다. 예: naver.com 또는 https://nid.naver.com');
    const name = (input.name?.trim().toLowerCase() || defaultName(domain)).replace(/[^a-z0-9._-]/g, '-');
    if (!NAME.test(name)) throw new VaultError('이름은 영문 소문자, 숫자, ".", "_", "-"로 32자 이내여야 합니다.');
    const username = input.username.trim();
    const password = input.password;
    if (!username) throw new VaultError('아이디를 입력하세요.');
    if (!password) throw new VaultError('비밀번호를 입력하세요.');
    if (username.length > 256 || password.length > 1024) throw new VaultError('입력값이 너무 깁니다.');
    const file = await this.load(user);
    const now = Date.now();
    const existing = file.entries.find((entry) => entry.name === name);
    const entry: StoredEntry = {
      name,
      domain,
      usernameHint: usernameHint(username),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sealed: this.seal(user, name, { username, password }),
    };
    const entries = file.entries.filter((candidate) => candidate.name !== name);
    if (entries.length >= MAX_ENTRIES) throw new VaultError(`저장할 수 있는 로그인은 ${MAX_ENTRIES}개까지입니다.`);
    entries.push(entry);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    await this.store(user, { version: 1, entries });
    log(`vault: ${existing ? 'updated' : 'saved'} login "${name}" (${domain}) for ${user}`);
    const { sealed: _sealed, createdAt: _createdAt, ...info } = entry;
    return info;
  }

  async delete(user: string, name: string): Promise<boolean> {
    const file = await this.load(user);
    const entries = file.entries.filter((entry) => entry.name !== name);
    if (entries.length === file.entries.length) return false;
    await this.store(user, { version: 1, entries });
    log(`vault: deleted login "${name}" for ${user}`);
    return true;
  }
}

export class VaultError extends Error {}

interface SecretLink {
  code: string;
  user: string;
  createdAt: number;
  expiresAt: number;
  closed: boolean;
}

export interface SecretLinkManagerOptions {
  publicUrl?: string | undefined;
}

/** The /secrets/<code> pages through which a person manages their saved logins. */
export class SecretLinkManager {
  private readonly links = new Map<string, SecretLink>();
  private readonly byUser = new Map<string, SecretLink>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly vault: Vault,
    private readonly options: SecretLinkManagerOptions = {},
  ) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  brokerFor(user: string, baseUrl: string): CredentialBroker {
    const base = (this.options.publicUrl ?? baseUrl).replace(/\/+$/, '');
    return {
      link: () => {
        const link = this.open(user);
        return { url: `${base}${SECRETS_PATH}/${link.code}`, expiresAt: link.expiresAt };
      },
      list: () => this.vault.list(user),
      get: (name) => this.vault.get(user, name),
    };
  }

  private open(user: string): SecretLink {
    const existing = this.byUser.get(user);
    const now = Date.now();
    if (existing && !existing.closed && existing.expiresAt > now) return existing;
    if (existing) this.links.delete(existing.code);
    const link: SecretLink = { code: randomBytes(24).toString('base64url'), user, createdAt: now, expiresAt: now + LINK_MINUTES * 60_000, closed: false };
    this.links.set(link.code, link);
    this.byUser.set(user, link);
    log(`credential link created for ${user}`);
    return link;
  }

  private sweep(): void {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (link.closed || link.expiresAt <= now) {
        this.links.delete(link.code);
        if (this.byUser.get(link.user) === link) this.byUser.delete(link.user);
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    this.links.clear();
    this.byUser.clear();
  }

  /** Serves /secrets/<code>[/list|/save|/delete|/close]. Returns false when the path is not ours. */
  async handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (pathname !== SECRETS_PATH && !pathname.startsWith(`${SECRETS_PATH}/`)) return false;
    const [, code = '', action = ''] = pathname.slice(SECRETS_PATH.length).split('/');
    const link = /^[A-Za-z0-9_-]{32}$/.test(code) ? this.links.get(code) : undefined;
    const method = req.method ?? 'GET';
    const live = link && !link.closed && link.expiresAt > Date.now();

    if (!live) {
      if (action === '') this.page(res, link ? 410 : 404, endedPage());
      else this.json(res, 410, { error: '이 링크는 만료되었습니다. AI에게 새 링크를 요청하세요.' });
      return true;
    }
    try {
      switch (action) {
        case '':
          if (method !== 'GET' && method !== 'HEAD') return this.methodNotAllowed(res, 'GET');
          this.page(res, 200, formPage());
          return true;
        case 'list':
          if (method !== 'GET') return this.methodNotAllowed(res, 'GET');
          this.json(res, 200, { entries: await this.vault.list(link.user), expiresAt: link.expiresAt });
          return true;
        case 'save': {
          if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
          const body = (await readJson(req)) as Record<string, unknown> | undefined;
          const field = (key: string): string => (typeof body?.[key] === 'string' ? (body[key] as string) : '');
          const saved = await this.vault.save(link.user, { name: field('name') || undefined, domain: field('domain'), username: field('username'), password: field('password') });
          this.json(res, 200, { saved, entries: await this.vault.list(link.user) });
          return true;
        }
        case 'delete': {
          if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
          const body = (await readJson(req)) as { name?: unknown } | undefined;
          const name = typeof body?.name === 'string' ? body.name : '';
          const deleted = await this.vault.delete(link.user, name);
          this.json(res, 200, { deleted, entries: await this.vault.list(link.user) });
          return true;
        }
        case 'close':
          if (method !== 'POST') return this.methodNotAllowed(res, 'POST');
          link.closed = true;
          this.json(res, 200, { closed: true });
          return true;
        default:
          this.json(res, 404, { error: 'not found' });
          return true;
      }
    } catch (error) {
      if (error instanceof VaultError) {
        this.json(res, 400, { error: error.message });
        return true;
      }
      throw error;
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
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'",
    });
    res.end(html);
  }
}

/** Constant-time comparison helper kept for callers that compare link codes outside the map lookup. */
export function codesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_INPUT_BYTES) throw new VaultError('입력값이 너무 깁니다.');
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
  :root { color-scheme: light dark; --bg: #f3f4f6; --fg: #111827; --muted: #6b7280; --card: #ffffff; --accent: #2563eb; --border: #e5e7eb; --danger: #dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #f3f4f6; --muted: #9ca3af; --card: #1c1f26; --accent: #60a5fa; --border: #2b2f3a; --danger: #f87171; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 520px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 13px; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-top: 16px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }
  input { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); }
  button { font: inherit; padding: 9px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; width: 100%; margin-top: 14px; }
  button.danger { color: var(--danger); padding: 4px 10px; font-size: 13px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
  li:first-child { border-top: 0; }
  li .grow { flex: 1; min-width: 0; }
  li .domain { color: var(--muted); font-size: 13px; }
  .msg { margin-top: 10px; font-size: 13px; min-height: 1.5em; }
  .msg.err { color: var(--danger); }
  .ended { text-align: center; padding: 60px 16px; }
`;

function formPage(): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>로그인 정보 저장</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>로그인 정보 저장</h1>
  <p class="muted">여기에 저장한 아이디와 비밀번호는 서버에서 암호화되어 보관되며 AI에게는 보이지 않습니다. AI는 저장된 사이트의 로그인 화면에서만 서버에 "채워 넣어 달라"고 요청할 수 있습니다. <span id="left"></span></p>
  <section>
    <h2>새 로그인 추가</h2>
    <label for="domain">사이트 주소</label>
    <input id="domain" placeholder="naver.com" autocomplete="off" autocapitalize="off">
    <label for="username">아이디</label>
    <input id="username" autocomplete="username" autocapitalize="off">
    <label for="password">비밀번호</label>
    <input id="password" type="password" autocomplete="current-password">
    <label for="name">이름 (선택, AI가 부를 이름)</label>
    <input id="name" placeholder="비우면 사이트 이름으로 저장 (예: naver)" autocomplete="off" autocapitalize="off">
    <button class="primary" id="save">저장</button>
    <div class="msg" id="msg"></div>
  </section>
  <section>
    <h2>저장된 로그인</h2>
    <ul id="list"><li class="muted">불러오는 중…</li></ul>
  </section>
  <p class="muted">다 끝나면 <button id="close">이 링크 닫기</button></p>
</main>
<script>
(() => {
  const base = location.pathname.replace(/\\/+$/, '');
  const $ = (id) => document.getElementById(id);
  const msg = $('msg'), list = $('list'), left = $('left');
  let expiresAt = 0;
  const post = async (path, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('오류 ' + r.status));
    return data;
  };
  const show = (text, err) => { msg.textContent = text; msg.className = 'msg' + (err ? ' err' : ''); };
  const render = (entries) => {
    list.innerHTML = '';
    if (!entries.length) { list.innerHTML = '<li class="muted">아직 없습니다.</li>'; return; }
    for (const e of entries) {
      const li = document.createElement('li');
      const grow = document.createElement('div'); grow.className = 'grow';
      const name = document.createElement('div'); name.textContent = e.name + '  (' + e.usernameHint + ')';
      const domain = document.createElement('div'); domain.className = 'domain'; domain.textContent = e.domain;
      grow.append(name, domain);
      const del = document.createElement('button'); del.className = 'danger'; del.textContent = '삭제';
      del.onclick = async () => { if (!confirm('"' + e.name + '" 로그인을 삭제할까요?')) return; try { render((await post('/delete', { name: e.name })).entries); } catch (err) { show(err.message, true); } };
      li.append(grow, del); list.append(li);
    }
  };
  const ended = (text) => { document.querySelector('main').innerHTML = '<div class="ended">' + text + '</div>'; };
  const load = async () => {
    const r = await fetch(base + '/list');
    if (!r.ok) { ended('이 링크는 만료되었습니다. AI에게 새 링크를 요청하세요.'); return; }
    const data = await r.json(); expiresAt = data.expiresAt; render(data.entries);
  };
  $('save').onclick = async () => {
    show('저장 중…');
    try {
      const data = await post('/save', { domain: $('domain').value, username: $('username').value, password: $('password').value, name: $('name').value });
      $('password').value = ''; $('name').value = '';
      show('"' + data.saved.name + '" 로그인을 저장했습니다. AI에게 "' + data.saved.name + ' 계정으로 로그인해 줘"라고 하면 됩니다.');
      render(data.entries);
    } catch (err) { show(err.message, true); }
  };
  $('close').onclick = async () => { try { await post('/close', {}); } catch {} ended('링크를 닫았습니다. 이 창은 닫아도 됩니다.'); };
  setInterval(() => {
    if (!expiresAt) return;
    const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    left.textContent = '이 링크는 ' + Math.floor(s / 60) + '분 ' + (s % 60) + '초 뒤 만료됩니다.';
    if (s === 0) ended('이 링크는 만료되었습니다. AI에게 새 링크를 요청하세요.');
  }, 1000);
  load();
})();
</script>
</body>
</html>`;
}

function endedPage(): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>로그인 정보 저장</title><style>${STYLE}</style></head>
<body><main><div class="ended">이 링크는 만료되었거나 존재하지 않습니다. AI에게 새 링크를 요청하세요.</div></main></body></html>`;
}
