import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadTokens, type TokenEntry } from './auth.js';
import { ConfigError } from './errors.js';

export { ConfigError } from './errors.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION: string = pkg.version;

export type BrowserName = 'chromium' | 'firefox' | 'webkit';
const BROWSER_NAMES: readonly BrowserName[] = ['chromium', 'firefox', 'webkit'];

export interface Config {
  browser: BrowserName;
  headless: boolean;
  channel?: string;
  executablePath?: string;
  userDataDir?: string;
  storageState?: string;
  viewport: { width: number; height: number };
  /** Default timeout for element actions, in milliseconds. */
  actionTimeout: number;
  /** Timeout for page navigations, in milliseconds. */
  navigationTimeout: number;
  userAgent?: string;
  locale?: string;
  ignoreHttpsErrors: boolean;
  /** Accessibility snapshots longer than this are truncated. */
  snapshotMaxChars: number;
  downloadsDir?: string;
  /** HTTP(S)/SOCKS proxy for the browser, e.g. "http://proxy.example.com:3128". */
  proxy?: string;
  /** Comma-separated hosts that bypass the proxy, e.g. "localhost,*.internal". */
  proxyBypass?: string;

  // ---- remote (HTTP) mode -----------------------------------------------------

  /** Serve MCP over Streamable HTTP for remote clients instead of stdio. */
  http: boolean;
  host: string;
  port: number;
  /** Bearer tokens that identify users of a shared server. */
  tokens: TokenEntry[];
  /** Run an HTTP server without tokens (only allowed on a loopback address). */
  allowUnauthenticated: boolean;
  /** Where per-user state lives in HTTP mode: storage state, downloads, uploads, screenshots. */
  dataDir: string;
  /** Sessions without tool calls for this long are closed, in milliseconds. */
  idleTimeoutMs: number;
  maxSessions: number;
  maxSessionsPerUser: number;
  /** Let the browser reach local files and private networks (default on for stdio, off for HTTP). */
  allowPrivateNetwork: boolean;

  // ---- Kakao Login (OAuth) -------------------------------------------------------

  /** Public base URL of this server as clients see it, e.g. https://browser.example.com (no trailing slash). */
  publicUrl?: string;
  /** REST API key of the Kakao app; when set, clients log in with their Kakao account. */
  kakaoClientId?: string;
  kakaoClientSecret?: string;
  /** Comma-separated Kakao consent items to request, e.g. "account_email". */
  kakaoScope?: string;
  /** Kakao user ids and/or e-mail addresses that may use the server; "*" allows every Kakao account. */
  allowedUsers: string[];
  /** Lifetime of access tokens issued after Kakao login, in milliseconds. */
  accessTokenTtlMs: number;
  /** Kakao endpoints; only overridden through environment variables in tests. */
  kakaoEndpoints: { authorizeUrl: string; tokenUrl: string; userInfoUrl: string };
}

export const DEFAULTS = {
  browser: 'chromium' as BrowserName,
  headless: false,
  viewport: { width: 1280, height: 720 },
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
  snapshotMaxChars: 30_000,
  host: '127.0.0.1',
  port: 3000,
  idleTimeoutSeconds: 900,
  maxSessions: 20,
  maxSessionsPerUser: 3,
  accessTokenTtlSeconds: 24 * 60 * 60,
  kakaoEndpoints: {
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    userInfoUrl: 'https://kapi.kakao.com/v2/user/me',
  },
};

export const USAGE = `browser-mcp ${VERSION} - MCP server that lets an AI control a browser through Playwright

Usage: browser-mcp [options]

Browser options:
  --headless                 Run the browser without a visible window (default: headed; always headless with --http)
  --headed                   Force a visible window (overrides BROWSER_MCP_HEADLESS)
  --browser <name>           chromium | firefox | webkit (default: chromium)
  --channel <channel>        Use an installed browser channel, e.g. chrome, msedge, chrome-beta
  --executable-path <path>   Launch a specific browser binary
  --user-data-dir <dir>      Persistent profile directory (keeps logins and cookies between runs; stdio mode only)
  --storage-state <file>     Playwright storage-state JSON to load (cookies, localStorage)
  --viewport <WxH>           Viewport size (default: ${DEFAULTS.viewport.width}x${DEFAULTS.viewport.height})
  --timeout <ms>             Default action timeout (default: ${DEFAULTS.actionTimeout})
  --navigation-timeout <ms>  Navigation timeout (default: ${DEFAULTS.navigationTimeout})
  --user-agent <ua>          Override the User-Agent string
  --locale <locale>          Browser locale, e.g. ko-KR
  --ignore-https-errors      Ignore TLS certificate errors
  --snapshot-max-chars <n>   Truncate accessibility snapshots beyond this size (default: ${DEFAULTS.snapshotMaxChars})
  --downloads-dir <dir>      Where downloaded files are saved (default: OS temp dir; per-user folder with --http)
  --proxy <url>              Proxy for the browser, e.g. http://proxy.example.com:3128 or socks5://host:1080
  --proxy-bypass <hosts>     Comma-separated hosts that bypass the proxy, e.g. "localhost,*.internal"

Remote (HTTP) mode:
  --http                     Serve MCP over Streamable HTTP at /mcp instead of stdio
  --host <host>              Address to listen on (default: ${DEFAULTS.host}; use 0.0.0.0 inside a container)
  --port <port>              Port to listen on (default: ${DEFAULTS.port}; 0 picks a free port)
  --tokens-file <file>       JSON file mapping bearer tokens to user names (see README)
  --allow-unauthenticated    Accept requests without a token (loopback address only)
  --data-dir <dir>           Per-user state directory (default: ~/.browser-mcp)
  --idle-timeout <seconds>   Close sessions idle for this long (default: ${DEFAULTS.idleTimeoutSeconds})
  --max-sessions <n>         Total concurrent sessions (default: ${DEFAULTS.maxSessions})
  --max-sessions-per-user <n> Concurrent sessions per user (default: ${DEFAULTS.maxSessionsPerUser})
  --allow-private-network    Let the browser open local files and private/loopback addresses (off by default with --http)

Kakao Login (clients authenticate with a Kakao account instead of static tokens):
  --public-url <url>         Public base URL of this server, e.g. https://browser.example.com (required)
  --kakao-client-id <key>    REST API key of the Kakao app
  --kakao-client-secret <s>  Client secret of the Kakao app (prefer BROWSER_MCP_KAKAO_CLIENT_SECRET)
  --kakao-scope <scopes>     Consent items to request, comma separated, e.g. account_email
  --allowed-users <list>     Kakao user ids and/or e-mails allowed to log in, comma separated; "*" allows everyone
  --access-token-ttl <sec>   Lifetime of issued access tokens (default: ${DEFAULTS.accessTokenTtlSeconds})

  -h, --help                 Show this help
  -v, --version              Print the version

Every option can also be set through an environment variable: BROWSER_MCP_HEADLESS,
BROWSER_MCP_BROWSER, BROWSER_MCP_CHANNEL, BROWSER_MCP_EXECUTABLE_PATH, BROWSER_MCP_USER_DATA_DIR,
BROWSER_MCP_STORAGE_STATE, BROWSER_MCP_VIEWPORT, BROWSER_MCP_TIMEOUT, BROWSER_MCP_NAVIGATION_TIMEOUT,
BROWSER_MCP_USER_AGENT, BROWSER_MCP_LOCALE, BROWSER_MCP_IGNORE_HTTPS_ERRORS,
BROWSER_MCP_SNAPSHOT_MAX_CHARS, BROWSER_MCP_DOWNLOADS_DIR, BROWSER_MCP_PROXY, BROWSER_MCP_PROXY_BYPASS,
BROWSER_MCP_HTTP, BROWSER_MCP_HOST, BROWSER_MCP_PORT, BROWSER_MCP_TOKENS_FILE,
BROWSER_MCP_TOKENS ("token1:alice,token2:bob"), BROWSER_MCP_ALLOW_UNAUTHENTICATED, BROWSER_MCP_DATA_DIR,
BROWSER_MCP_IDLE_TIMEOUT, BROWSER_MCP_MAX_SESSIONS, BROWSER_MCP_MAX_SESSIONS_PER_USER,
BROWSER_MCP_ALLOW_PRIVATE_NETWORK, BROWSER_MCP_PUBLIC_URL, BROWSER_MCP_KAKAO_CLIENT_ID,
BROWSER_MCP_KAKAO_CLIENT_SECRET, BROWSER_MCP_KAKAO_SCOPE, BROWSER_MCP_ALLOWED_USERS,
BROWSER_MCP_ACCESS_TOKEN_TTL. Command-line flags take precedence.
`;

export type ParsedArgs = { kind: 'run'; config: Config } | { kind: 'help' } | { kind: 'version' };

function isBrowserName(value: string): value is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(value);
}

/** True for addresses that only the local machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || value === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(value);
}

function parseViewport(value: string, source: string): { width: number; height: number } {
  const match = /^\s*(\d+)\s*[xX,]\s*(\d+)\s*$/.exec(value);
  if (!match) throw new ConfigError(`${source} must look like 1280x720 (got "${value}")`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 100 || height < 100) throw new ConfigError(`${source} is too small (got "${value}")`);
  return { width, height };
}

function parsePositiveInt(value: string, source: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${source} must be a positive integer (got "${value}")`);
  return n;
}

function parsePort(value: string, source: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new ConfigError(`${source} must be a port number 0-65535 (got "${value}")`);
  return n;
}

export function parseConfig(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  let values: Record<string, string | boolean | undefined>;
  try {
    values = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        headless: { type: 'boolean' },
        headed: { type: 'boolean' },
        browser: { type: 'string' },
        channel: { type: 'string' },
        'executable-path': { type: 'string' },
        'user-data-dir': { type: 'string' },
        'storage-state': { type: 'string' },
        viewport: { type: 'string' },
        timeout: { type: 'string' },
        'navigation-timeout': { type: 'string' },
        'user-agent': { type: 'string' },
        locale: { type: 'string' },
        'ignore-https-errors': { type: 'boolean' },
        'snapshot-max-chars': { type: 'string' },
        'downloads-dir': { type: 'string' },
        proxy: { type: 'string' },
        'proxy-bypass': { type: 'string' },
        http: { type: 'boolean' },
        host: { type: 'string' },
        port: { type: 'string' },
        'tokens-file': { type: 'string' },
        'allow-unauthenticated': { type: 'boolean' },
        'data-dir': { type: 'string' },
        'idle-timeout': { type: 'string' },
        'max-sessions': { type: 'string' },
        'max-sessions-per-user': { type: 'string' },
        'allow-private-network': { type: 'boolean' },
        'public-url': { type: 'string' },
        'kakao-client-id': { type: 'string' },
        'kakao-client-secret': { type: 'string' },
        'kakao-scope': { type: 'string' },
        'allowed-users': { type: 'string' },
        'access-token-ttl': { type: 'string' },
      },
    }).values;
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }

  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  const str = (flag: string, envName: string): string | undefined => {
    const fromFlag = values[flag];
    if (typeof fromFlag === 'string' && fromFlag.trim() !== '') return fromFlag.trim();
    const fromEnv = env[`BROWSER_MCP_${envName}`];
    return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv.trim() : undefined;
  };
  const bool = (flag: string, envName: string): boolean | undefined => {
    if (values[flag] === true) return true;
    const fromEnv = env[`BROWSER_MCP_${envName}`];
    if (fromEnv === undefined || fromEnv.trim() === '') return undefined;
    return ['1', 'true', 'yes', 'on'].includes(fromEnv.trim().toLowerCase());
  };

  const browser = (str('browser', 'BROWSER') ?? DEFAULTS.browser).toLowerCase();
  if (!isBrowserName(browser)) {
    throw new ConfigError(`--browser must be one of ${BROWSER_NAMES.join(', ')} (got "${browser}")`);
  }

  const http = bool('http', 'HTTP') ?? false;
  // A remote server has no display, so HTTP mode is headless unless --headed is given explicitly.
  const headless = values.headed === true ? false : (bool('headless', 'HEADLESS') ?? (http ? true : DEFAULTS.headless));
  const viewportRaw = str('viewport', 'VIEWPORT');
  const timeoutRaw = str('timeout', 'TIMEOUT');
  const navigationTimeoutRaw = str('navigation-timeout', 'NAVIGATION_TIMEOUT');
  const snapshotMaxRaw = str('snapshot-max-chars', 'SNAPSHOT_MAX_CHARS');
  const portRaw = str('port', 'PORT');
  const idleRaw = str('idle-timeout', 'IDLE_TIMEOUT');
  const maxSessionsRaw = str('max-sessions', 'MAX_SESSIONS');
  const maxPerUserRaw = str('max-sessions-per-user', 'MAX_SESSIONS_PER_USER');
  const accessTtlRaw = str('access-token-ttl', 'ACCESS_TOKEN_TTL');
  const allowedUsersRaw = str('allowed-users', 'ALLOWED_USERS');

  const config: Config = {
    browser,
    headless,
    channel: str('channel', 'CHANNEL'),
    executablePath: str('executable-path', 'EXECUTABLE_PATH'),
    userDataDir: str('user-data-dir', 'USER_DATA_DIR'),
    storageState: str('storage-state', 'STORAGE_STATE'),
    viewport: viewportRaw ? parseViewport(viewportRaw, '--viewport') : DEFAULTS.viewport,
    actionTimeout: timeoutRaw ? parsePositiveInt(timeoutRaw, '--timeout') : DEFAULTS.actionTimeout,
    navigationTimeout: navigationTimeoutRaw
      ? parsePositiveInt(navigationTimeoutRaw, '--navigation-timeout')
      : DEFAULTS.navigationTimeout,
    userAgent: str('user-agent', 'USER_AGENT'),
    locale: str('locale', 'LOCALE'),
    ignoreHttpsErrors: bool('ignore-https-errors', 'IGNORE_HTTPS_ERRORS') ?? false,
    snapshotMaxChars: snapshotMaxRaw
      ? parsePositiveInt(snapshotMaxRaw, '--snapshot-max-chars')
      : DEFAULTS.snapshotMaxChars,
    downloadsDir: str('downloads-dir', 'DOWNLOADS_DIR'),
    proxy: str('proxy', 'PROXY'),
    proxyBypass: str('proxy-bypass', 'PROXY_BYPASS'),
    http,
    host: str('host', 'HOST') ?? DEFAULTS.host,
    port: portRaw ? parsePort(portRaw, '--port') : DEFAULTS.port,
    tokens: http ? loadTokens(str('tokens-file', 'TOKENS_FILE'), env.BROWSER_MCP_TOKENS) : [],
    allowUnauthenticated: bool('allow-unauthenticated', 'ALLOW_UNAUTHENTICATED') ?? false,
    dataDir: str('data-dir', 'DATA_DIR') ?? path.join(os.homedir(), '.browser-mcp'),
    idleTimeoutMs: (idleRaw ? parsePositiveInt(idleRaw, '--idle-timeout') : DEFAULTS.idleTimeoutSeconds) * 1_000,
    maxSessions: maxSessionsRaw ? parsePositiveInt(maxSessionsRaw, '--max-sessions') : DEFAULTS.maxSessions,
    maxSessionsPerUser: maxPerUserRaw ? parsePositiveInt(maxPerUserRaw, '--max-sessions-per-user') : DEFAULTS.maxSessionsPerUser,
    allowPrivateNetwork: bool('allow-private-network', 'ALLOW_PRIVATE_NETWORK') ?? !http,
    publicUrl: str('public-url', 'PUBLIC_URL')?.replace(/\/+$/, ''),
    kakaoClientId: str('kakao-client-id', 'KAKAO_CLIENT_ID'),
    kakaoClientSecret: str('kakao-client-secret', 'KAKAO_CLIENT_SECRET'),
    kakaoScope: str('kakao-scope', 'KAKAO_SCOPE'),
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [],
    accessTokenTtlMs: (accessTtlRaw ? parsePositiveInt(accessTtlRaw, '--access-token-ttl') : DEFAULTS.accessTokenTtlSeconds) * 1_000,
    kakaoEndpoints: {
      authorizeUrl: env.BROWSER_MCP_KAKAO_AUTHORIZE_URL?.trim() || DEFAULTS.kakaoEndpoints.authorizeUrl,
      tokenUrl: env.BROWSER_MCP_KAKAO_TOKEN_URL?.trim() || DEFAULTS.kakaoEndpoints.tokenUrl,
      userInfoUrl: env.BROWSER_MCP_KAKAO_USERINFO_URL?.trim() || DEFAULTS.kakaoEndpoints.userInfoUrl,
    },
  };

  if (config.proxyBypass && !config.proxy) {
    throw new ConfigError('--proxy-bypass requires --proxy');
  }

  if (config.userDataDir && config.storageState) {
    throw new ConfigError(
      '--storage-state cannot be combined with --user-data-dir (a persistent profile has its own storage)',
    );
  }

  if (config.http) {
    if (config.userDataDir) {
      throw new ConfigError(
        '--user-data-dir cannot be used with --http: every session gets its own browser, and logins are kept per user under --data-dir',
      );
    }
    const hasAuth = config.tokens.length > 0 || config.kakaoClientId !== undefined;
    if (!hasAuth && !config.allowUnauthenticated) {
      throw new ConfigError(
        'HTTP mode needs a way to identify users: Kakao login (--kakao-client-id with --public-url) or static tokens (--tokens-file / BROWSER_MCP_TOKENS). ' +
          'Pass --allow-unauthenticated only for a test server on 127.0.0.1',
      );
    }
    if (!hasAuth && !isLoopbackHost(config.host)) {
      throw new ConfigError(`refusing to listen on ${config.host} without authentication; --allow-unauthenticated only works on a loopback address`);
    }
    if (config.kakaoClientId) {
      if (!config.publicUrl) throw new ConfigError('--public-url is required with --kakao-client-id (clients are redirected back to it)');
      let parsed: URL;
      try {
        parsed = new URL(config.publicUrl);
      } catch {
        throw new ConfigError(`--public-url must be an absolute URL (got "${config.publicUrl}")`);
      }
      if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
        throw new ConfigError('--public-url must use https (plain http is only accepted for a loopback address)');
      }
      if (parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
        throw new ConfigError('--public-url must be the origin only, without a path (e.g. https://browser.example.com)');
      }
    } else if (config.kakaoClientSecret || config.kakaoScope || config.allowedUsers.length > 0) {
      throw new ConfigError('--kakao-client-secret, --kakao-scope and --allowed-users require --kakao-client-id');
    }
  } else if (config.allowUnauthenticated || config.tokens.length > 0 || config.kakaoClientId) {
    throw new ConfigError('--allow-unauthenticated, tokens and Kakao login only apply to --http mode');
  }

  return { kind: 'run', config };
}
