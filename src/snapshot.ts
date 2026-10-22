import type { Page } from 'playwright';
import type { BrowserSession } from './browser.js';

export interface DescribeOptions {
  /** Include the accessibility snapshot (default true). */
  snapshot?: boolean;
  /** Limit the snapshot to this element (ref from a previous snapshot). */
  ref?: string | undefined;
  /** Limit the snapshot to elements matching this selector. */
  selector?: string | undefined;
  /** Override the configured truncation limit. */
  maxChars?: number | undefined;
  /**
   * Extra lines shown before the snapshot (e.g. "a new tab opened"). A function is
   * evaluated after the snapshot is captured, so late-arriving events (popups) are seen.
   */
  notes?: string[] | (() => string[]);
}

/** Cuts YAML at a line boundary and explains how to see the rest. */
export function truncateSnapshot(yaml: string, maxChars: number): string {
  if (yaml.length <= maxChars) return yaml;
  const cutAt = yaml.lastIndexOf('\n', maxChars);
  const shown = yaml.slice(0, cutAt > maxChars / 2 ? cutAt : maxChars);
  return (
    `${shown}\n... [snapshot truncated: ${shown.length} of ${yaml.length} characters shown. ` +
    'Call browser_snapshot with a ref or selector to focus on part of the page, or browser_get_text to read text.]'
  );
}

async function withNavigationRetry(page: Page, take: () => Promise<string>): Promise<string> {
  try {
    return await take();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!page.isClosed() && /Execution context was destroyed|navigating|frame was detached/i.test(message)) {
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
      return take();
    }
    throw error;
  }
}

/** Accessibility snapshot in Playwright's AI mode: every element carries a `[ref=eN]` id. */
export async function captureSnapshot(session: BrowserSession, page: Page, options: DescribeOptions = {}): Promise<string> {
  const maxChars = options.maxChars ?? session.config.snapshotMaxChars;
  const scoped = options.ref || options.selector ? session.resolveTarget(page, options) : page;
  const yaml = await withNavigationRetry(page, () => scoped.ariaSnapshot({ mode: 'ai' }));
  return truncateSnapshot(yaml.trim() || '(empty: no accessible content)', maxChars);
}

/** Page header (title, URL, tabs, dialog) followed by the snapshot, as returned by most tools. */
export async function describePage(session: BrowserSession, page: Page, options: DescribeOptions = {}): Promise<string> {
  const dialogNote = session.dialogNote(page);
  // page.title() evaluates in the page and would hang while a dialog is open.
  const title = dialogNote ? undefined : await page.title().catch(() => undefined);
  const yaml = options.snapshot !== false && !dialogNote ? await captureSnapshot(session, page, options) : undefined;

  // Tabs and notes are evaluated last: a popup opened by the action may register only now.
  const lines: string[] = [`Page: ${title ?? '(title unavailable)'}`, `URL: ${page.url()}`];
  const tabs = session.tabs();
  if (tabs.length > 1) {
    lines.push(`Tabs: ${tabs.length} open, active tab index ${session.tabIndex(page)} (use browser_tabs to list or switch).`);
  }
  const notes = typeof options.notes === 'function' ? options.notes() : (options.notes ?? []);
  lines.push(...notes);
  if (dialogNote) lines.push(`Dialog: ${dialogNote}`);

  if (yaml !== undefined) {
    const scope = options.ref ? ` of ${options.ref}` : options.selector ? ` of ${JSON.stringify(options.selector)}` : '';
    lines.push(
      '',
      `Accessibility snapshot${scope} (use the [ref=...] ids with browser_click, browser_type, etc.; refs are valid for the most recent snapshot only):`,
      '```yaml',
      yaml,
      '```',
    );
  }
  return lines.join('\n');
}
