import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  BrowserType,
  Dialog,
  Download,
  LaunchOptions,
  Locator,
  Page,
  Request,
} from 'playwright';
import type { BrowserName, Config } from './config.js';
import { log } from './log.js';
import { isBlockedScheme, logBlocked, type UrlGuard } from './policy.js';

/** An error whose message is written for the AI agent and returned as-is. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  timestamp: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  timestamp: number;
}

export interface DownloadEntry {
  url: string;
  suggestedFilename: string;
  savedPath?: string;
  error?: string;
  timestamp: number;
}

export interface ElementTarget {
  ref?: string | undefined;
  selector?: string | undefined;
}

/** Per-user folders on a shared server; paths given by the agent are confined to these. */
export interface Workspace {
  root: string;
  downloads: string;
  files: string;
  screenshots: string;
}

export interface BrowserSessionOptions {
  workspace?: Workspace;
  /** JSON file with this user's cookies and storage: loaded at launch, saved after actions and on close. */
  storageStatePath?: string;
  /** Refuses URLs that point at local files or private networks. */
  guard?: UrlGuard;
}

const PERSIST_DELAY_MS = 2_000;
const PERSIST_TIMEOUT_MS = 5_000;

interface PageState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  dialog?: Dialog;
  dialogWaiters: Array<(dialog: Dialog) => void>;
}

const MAX_LOG_ENTRIES = 500;
const ENGINES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };

function pushCapped<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_LOG_ENTRIES) list.splice(0, list.length - MAX_LOG_ENTRIES);
}

/** Drops `undefined` values so Playwright's option validation only sees real settings. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Accepts "e12", "[ref=e12]", "ref=e12" and iframe refs like "f1e3". */
export function normalizeRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const value = ref.trim().replace(/^\[?ref=/, '').replace(/\]$/, '');
  if (!value) return undefined;
  if (!/^(?:f\d+)*e\d+$/.test(value)) {
    throw new UserError(
      `"${ref}" is not a valid element ref. Refs look like "e12" or "f3e12" and come from the most recent snapshot.`,
    );
  }
  return value;
}

/** Adds a scheme when the agent passes a bare host such as "example.com" or "localhost:3000". */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) throw new UserError('url must not be empty.');
  if (/^(https?|file|about|data|blob|chrome|chrome-extension|view-source|devtools):/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(url)) return `http://${url}`;
  if (/^[^/\s]+:\d+([/?#]|$)/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

/**
 * Owns the Playwright browser for the lifetime of the MCP server: lazy launch,
 * tab bookkeeping, dialog tracking and per-page console/network logs.
 */
/** Serializes work on one browser: Playwright actions from different callers must not interleave. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private launching?: Promise<BrowserContext>;
  private readonly pages = new Map<Page, PageState>();
  private activePage?: Page;
  private persistTimer?: NodeJS.Timeout;
  private readonly blockedSeen = new Set<string>();
  readonly downloads: DownloadEntry[] = [];
  /** Tool calls and shutdown run one at a time through this lock, even from several MCP sessions. */
  readonly mutex = new Mutex();

  constructor(
    readonly config: Config,
    readonly options: BrowserSessionOptions = {},
  ) {}

  get running(): boolean {
    return this.context !== undefined;
  }

  /** URL of the active tab, for log lines. */
  activeUrl(): string | undefined {
    return this.activePage && !this.activePage.isClosed() ? this.activePage.url() : undefined;
  }

  async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    const { config } = this;
    const engine = ENGINES[config.browser];
    const launchOptions: LaunchOptions = compact({
      headless: config.headless,
      channel: config.channel,
      executablePath: config.executablePath,
      proxy: config.proxy ? compact({ server: config.proxy, bypass: config.proxyBypass }) : undefined,
    });
    const contextOptions: BrowserContextOptions = compact({
      viewport: config.viewport,
      ignoreHTTPSErrors: config.ignoreHttpsErrors,
      userAgent: config.userAgent,
      locale: config.locale,
      acceptDownloads: true,
    });

    log(
      `launching ${config.browser}${config.channel ? ` (${config.channel})` : ''} in ${
        config.headless ? 'headless' : 'headed'
      } mode`,
    );

    let context: BrowserContext;
    if (config.userDataDir) {
      context = await engine.launchPersistentContext(config.userDataDir, { ...launchOptions, ...contextOptions });
      this.browser = context.browser() ?? undefined;
    } else {
      const browser = await engine.launch(launchOptions);
      this.browser = browser;
      const storageState = await this.initialStorageState();
      context = await browser.newContext(compact({ ...contextOptions, storageState }));
    }

    context.setDefaultTimeout(config.actionTimeout);
    context.setDefaultNavigationTimeout(config.navigationTimeout);
    if (this.options.guard) await this.installGuard(context, this.options.guard);
    context.on('page', (page) => this.attachPage(page));
    context.on('close', () => {
      if (this.context === context) {
        log('browser context closed');
        this.reset();
      }
    });
    for (const page of context.pages()) this.attachPage(page);
    this.context = context;
    return context;
  }

  /** The user's saved state when it exists, otherwise the configured seed file (if any). */
  private async initialStorageState(): Promise<string | undefined> {
    const saved = this.options.storageStatePath;
    if (saved) {
      const exists = await access(saved).then(() => true, () => false);
      if (exists) return saved;
    }
    return this.config.storageState;
  }

  /** Every request the browser makes is checked against the network policy; refused ones fail like a blocked request. */
  private async installGuard(context: BrowserContext, guard: UrlGuard): Promise<void> {
    await context.route('**/*', async (route, request) => {
      const url = request.url();
      const reason = await guard.check(url).catch(() => 'the URL could not be checked');
      if (reason) {
        logBlocked(reason, url, this.blockedSeen);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
  }

  /** Refuses a URL the network policy does not allow; a no-op without a guard (local use). */
  async checkUrl(url: string): Promise<void> {
    const guard = this.options.guard;
    if (!guard) return;
    const reason = await guard.check(url);
    if (reason) throw new UserError(`Cannot open ${url}: ${reason}.`);
  }

  /**
   * Maps an agent-supplied path to a real path. Without a workspace (local use) the path is
   * used as given; with one, relative paths land in the matching workspace folder and anything
   * outside the workspace is refused.
   */
  resolvePath(input: string, kind: 'files' | 'screenshots'): string {
    const workspace = this.options.workspace;
    if (!workspace) return path.resolve(input);
    const resolved = path.resolve(workspace[kind], input);
    const relative = path.relative(workspace.root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new UserError(
        `Paths on this server must stay inside your workspace. Use a relative path such as "${path.basename(input) || 'file'}"; ` +
          `it is stored under the ${kind} folder of your workspace.`,
      );
    }
    return resolved;
  }

  /** How a path should be shown to the agent: relative to the workspace when there is one. */
  displayPath(resolved: string): string {
    const workspace = this.options.workspace;
    return workspace ? path.relative(workspace.root, resolved) : resolved;
  }

  /** Saves cookies and storage to the user's state file shortly after an action (debounced). */
  schedulePersist(): void {
    if (!this.options.storageStatePath || !this.context || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistState();
    }, PERSIST_DELAY_MS);
    this.persistTimer.unref();
  }

  /** Writes the context's cookies and storage to the user's state file. */
  async persistState(): Promise<void> {
    const target = this.options.storageStatePath;
    const context = this.context;
    if (!target || !context) return;
    // Reading storage evaluates in pages; a page with an open dialog would never answer.
    if (this.tabs().some((page) => this.dialogFor(page))) return;
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), PERSIST_TIMEOUT_MS).unref(),
      );
      const state = await Promise.race([context.storageState(), timeout]);
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
      await rename(tmp, target);
    } catch (error) {
      log(`could not save storage state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private reset(): void {
    this.browser = undefined;
    this.context = undefined;
    this.pages.clear();
    this.activePage = undefined;
  }

  async close(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.persistState();
    const { context, browser } = this;
    this.reset();
    if (context) await context.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    if (context || browser) log('browser closed');
  }

  private attachPage(page: Page): void {
    if (this.pages.has(page)) return;
    const state: PageState = { console: [], network: [], dialogWaiters: [] };
    this.pages.set(page, state);
    this.activePage ??= page;

    page.on('console', (message) => {
      const location = message.location();
      pushCapped(state.console, {
        type: message.type(),
        text: message.text(),
        location: location.url ? `${location.url}:${location.lineNumber + 1}:${location.columnNumber + 1}` : undefined,
        timestamp: Date.now(),
      });
    });
    page.on('pageerror', (error) => {
      pushCapped(state.console, { type: 'error', text: `Uncaught ${error.name}: ${error.message}`, timestamp: Date.now() });
    });
    page.on('dialog', (dialog) => {
      state.dialog = dialog;
      for (const waiter of state.dialogWaiters.splice(0)) waiter(dialog);
    });

    const entries = new WeakMap<Request, NetworkEntry>();
    page.on('request', (request) => {
      const entry: NetworkEntry = {
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        timestamp: Date.now(),
      };
      entries.set(request, entry);
      pushCapped(state.network, entry);
    });
    page.on('response', (response) => {
      const entry = entries.get(response.request());
      if (entry) entry.status = response.status();
    });
    page.on('requestfailed', (request) => {
      const entry = entries.get(request);
      if (entry) entry.failure = request.failure()?.errorText ?? 'failed';
    });
    page.on('download', (download) => void this.saveDownload(download));
    if (this.options.guard) {
      // Belt and braces: a navigation to a browser-internal or file URL that slipped past the
      // request check (those schemes are not routed) is undone immediately.
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame() || !isBlockedScheme(frame.url())) return;
        logBlocked('blocked scheme', frame.url(), this.blockedSeen);
        void page.goto('about:blank').catch(() => undefined);
      });
    }
    page.on('close', () => {
      this.pages.delete(page);
      if (this.activePage === page) this.activePage = this.tabs().at(-1);
    });
  }

  private async saveDownload(download: Download): Promise<void> {
    const entry: DownloadEntry = {
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
      timestamp: Date.now(),
    };
    this.downloads.push(entry);
    try {
      const dir = this.options.workspace?.downloads ?? this.config.downloadsDir ?? path.join(os.tmpdir(), 'browser-mcp-downloads');
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${path.basename(entry.suggestedFilename) || 'download'}`);
      await download.saveAs(target);
      entry.savedPath = target;
      log(`download saved to ${target}`);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }

  // ---- tabs -----------------------------------------------------------------

  /** Open tabs in creation order. The index in this list is the tab index exposed to the agent. */
  tabs(): Page[] {
    return [...this.pages.keys()].filter((page) => !page.isClosed());
  }

  tabIndex(page: Page): number {
    return this.tabs().indexOf(page);
  }

  /** The active tab when the browser is running and has one; never launches anything. */
  currentPage(): Page | undefined {
    return this.activePage && !this.activePage.isClosed() ? this.activePage : undefined;
  }

  /** The active tab, launching the browser and opening a blank tab when needed. */
  async page(): Promise<Page> {
    const context = await this.ensureContext();
    if (!this.activePage || this.activePage.isClosed()) {
      const page = this.tabs().at(-1) ?? (await context.newPage());
      this.attachPage(page);
      this.activePage = page;
    }
    return this.activePage;
  }

  async newTab(url?: string): Promise<Page> {
    if (url) await this.checkUrl(url);
    const context = await this.ensureContext();
    const page = await context.newPage();
    this.attachPage(page);
    this.activePage = page;
    if (url) await page.goto(url);
    return page;
  }

  async selectTab(index: number): Promise<Page> {
    const page = this.tabs()[index];
    if (!page) throw new UserError(this.noSuchTab(index));
    this.activePage = page;
    await page.bringToFront();
    return page;
  }

  async closeTab(index?: number): Promise<void> {
    const page = index === undefined ? await this.page() : this.tabs()[index];
    if (!page) throw new UserError(this.noSuchTab(index ?? 0));
    await page.close();
  }

  private noSuchTab(index: number): string {
    const count = this.tabs().length;
    return count === 0
      ? `No tab with index ${index}: no tabs are open.`
      : `No tab with index ${index}. Valid indexes are 0 to ${count - 1}.`;
  }

  // ---- dialogs --------------------------------------------------------------

  dialogFor(page: Page): Dialog | undefined {
    return this.pages.get(page)?.dialog;
  }

  /** Human-readable description of the pending dialog on `page`, if any. */
  dialogNote(page: Page): string | undefined {
    const dialog = this.dialogFor(page);
    if (!dialog) return undefined;
    const defaultValue = dialog.defaultValue();
    return (
      `A "${dialog.type()}" dialog is open with message ${JSON.stringify(dialog.message())}` +
      (defaultValue ? ` (default value ${JSON.stringify(defaultValue)})` : '') +
      '. Call browser_handle_dialog to accept or dismiss it before doing anything else on this page.'
    );
  }

  assertNoDialog(page: Page): void {
    const note = this.dialogNote(page);
    if (note) throw new UserError(note);
  }

  async handleDialog(page: Page, accept: boolean, promptText?: string): Promise<string> {
    const state = this.pages.get(page);
    const dialog = state?.dialog;
    if (!state || !dialog) throw new UserError('No dialog is currently open on the active tab.');
    state.dialog = undefined;
    const description = `${dialog.type()} dialog ${JSON.stringify(dialog.message())}`;
    try {
      if (accept) await dialog.accept(promptText);
      else await dialog.dismiss();
    } catch (error) {
      throw new UserError(
        `Could not handle the ${description}; it may already have been closed (${
          error instanceof Error ? error.message : String(error)
        }).`,
      );
    }
    return `${accept ? 'Accepted' : 'Dismissed'} the ${description}.`;
  }

  /**
   * Awaits `action`, but returns as soon as a dialog opens on `page` instead,
   * because a page with an open dialog never finishes any other action.
   */
  async raceDialog<T>(page: Page, action: Promise<T>): Promise<{ dialog: Dialog } | { value: T }> {
    const state = this.pages.get(page);
    if (!state) return { value: await action };
    if (state.dialog) {
      action.catch(() => undefined);
      return { dialog: state.dialog };
    }
    let waiter: ((dialog: Dialog) => void) | undefined;
    const dialogOpened = new Promise<{ dialog: Dialog }>((resolve) => {
      waiter = (dialog) => resolve({ dialog });
      state.dialogWaiters.push(waiter);
    });
    try {
      return await Promise.race([action.then((value) => ({ value })), dialogOpened]);
    } finally {
      if (waiter) {
        const index = state.dialogWaiters.indexOf(waiter);
        if (index >= 0) state.dialogWaiters.splice(index, 1);
      }
      // If the dialog won the race the action is abandoned; swallow its eventual rejection.
      action.catch(() => undefined);
    }
  }

  // ---- logs -----------------------------------------------------------------

  consoleEntries(page: Page): ConsoleEntry[] {
    return this.pages.get(page)?.console ?? [];
  }

  clearConsole(page: Page): void {
    const state = this.pages.get(page);
    if (state) state.console = [];
  }

  networkEntries(page: Page): NetworkEntry[] {
    return this.pages.get(page)?.network ?? [];
  }

  clearNetwork(page: Page): void {
    const state = this.pages.get(page);
    if (state) state.network = [];
  }

  // ---- element targeting ----------------------------------------------------

  /** Resolves an agent-supplied target (snapshot ref or Playwright selector) to a locator. */
  resolveTarget(page: Page, target: ElementTarget): Locator {
    const ref = normalizeRef(target.ref);
    if (ref) return page.getByRef(ref);
    const selector = target.selector?.trim();
    if (selector) return page.locator(selector);
    throw new UserError('Provide either "ref" (an element ref from the most recent snapshot) or "selector".');
  }
}

export function describeTarget(target: ElementTarget): string {
  const ref = normalizeRef(target.ref);
  if (ref) return `element ${ref}`;
  return `element matching ${JSON.stringify(target.selector?.trim() ?? '')}`;
}
