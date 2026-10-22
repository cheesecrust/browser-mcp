import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

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
}

export const DEFAULTS = {
  browser: 'chromium' as BrowserName,
  headless: false,
  viewport: { width: 1280, height: 720 },
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
  snapshotMaxChars: 30_000,
};

export const USAGE = `browser-mcp ${VERSION} - MCP server that lets an AI control a browser through Playwright

Usage: browser-mcp [options]

Options:
  --headless                 Run the browser without a visible window (default: headed)
  --headed                   Force a visible window (overrides BROWSER_MCP_HEADLESS)
  --browser <name>           chromium | firefox | webkit (default: chromium)
  --channel <channel>        Use an installed browser channel, e.g. chrome, msedge, chrome-beta
  --executable-path <path>   Launch a specific browser binary
  --user-data-dir <dir>      Persistent profile directory (keeps logins and cookies between runs)
  --storage-state <file>     Playwright storage-state JSON to load (cookies, localStorage)
  --viewport <WxH>           Viewport size (default: ${DEFAULTS.viewport.width}x${DEFAULTS.viewport.height})
  --timeout <ms>             Default action timeout (default: ${DEFAULTS.actionTimeout})
  --navigation-timeout <ms>  Navigation timeout (default: ${DEFAULTS.navigationTimeout})
  --user-agent <ua>          Override the User-Agent string
  --locale <locale>          Browser locale, e.g. ko-KR
  --ignore-https-errors      Ignore TLS certificate errors
  --snapshot-max-chars <n>   Truncate accessibility snapshots beyond this size (default: ${DEFAULTS.snapshotMaxChars})
  --downloads-dir <dir>      Where downloaded files are saved (default: OS temp dir)
  --proxy <url>              Proxy for the browser, e.g. http://proxy.example.com:3128 or socks5://host:1080
  --proxy-bypass <hosts>     Comma-separated hosts that bypass the proxy, e.g. "localhost,*.internal"
  -h, --help                 Show this help
  -v, --version              Print the version

Every option can also be set through an environment variable: BROWSER_MCP_HEADLESS,
BROWSER_MCP_BROWSER, BROWSER_MCP_CHANNEL, BROWSER_MCP_EXECUTABLE_PATH, BROWSER_MCP_USER_DATA_DIR,
BROWSER_MCP_STORAGE_STATE, BROWSER_MCP_VIEWPORT, BROWSER_MCP_TIMEOUT, BROWSER_MCP_NAVIGATION_TIMEOUT,
BROWSER_MCP_USER_AGENT, BROWSER_MCP_LOCALE, BROWSER_MCP_IGNORE_HTTPS_ERRORS,
BROWSER_MCP_SNAPSHOT_MAX_CHARS, BROWSER_MCP_DOWNLOADS_DIR, BROWSER_MCP_PROXY, BROWSER_MCP_PROXY_BYPASS.
Command-line flags take precedence.
`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ParsedArgs = { kind: 'run'; config: Config } | { kind: 'help' } | { kind: 'version' };

function isBrowserName(value: string): value is BrowserName {
  return (BROWSER_NAMES as readonly string[]).includes(value);
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

  const headless = values.headed === true ? false : (bool('headless', 'HEADLESS') ?? DEFAULTS.headless);
  const viewportRaw = str('viewport', 'VIEWPORT');
  const timeoutRaw = str('timeout', 'TIMEOUT');
  const navigationTimeoutRaw = str('navigation-timeout', 'NAVIGATION_TIMEOUT');
  const snapshotMaxRaw = str('snapshot-max-chars', 'SNAPSHOT_MAX_CHARS');

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
  };

  if (config.proxyBypass && !config.proxy) {
    throw new ConfigError('--proxy-bypass requires --proxy');
  }

  if (config.userDataDir && config.storageState) {
    throw new ConfigError(
      '--storage-state cannot be combined with --user-data-dir (a persistent profile has its own storage)',
    );
  }

  return { kind: 'run', config };
}
