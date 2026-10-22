import * as z from 'zod/v4';
import { normalizeUrl, UserError, type BrowserSession } from '../browser.js';
import { ACTION, READ_ONLY, pageResult, type ToolRegistrar } from './common.js';

async function listTabs(session: BrowserSession): Promise<string> {
  const active = await session.page();
  const tabs = session.tabs();
  const lines = await Promise.all(
    tabs.map(async (page, index) => {
      const title = session.dialogFor(page) ? '(dialog open)' : await page.title().catch(() => '');
      return `[${index}]${page === active ? ' (active)' : ''} ${title || '(no title)'} - ${page.url()}`;
    }),
  );
  return `${tabs.length} open tab${tabs.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

export function registerTabTools(tool: ToolRegistrar): void {
  tool(
    'browser_tabs',
    {
      title: 'Manage tabs',
      description:
        'List, open, switch to, or close browser tabs. Links that open in a new tab are reported by the action that triggered them; use action "select" to switch to such a tab.',
      input: {
        action: z.enum(['list', 'new', 'select', 'close']).describe('What to do.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Tab index (from "list") for "select" and "close". "close" defaults to the active tab.'),
        url: z.string().optional().describe('URL to open in the new tab (action "new"); defaults to a blank tab.'),
      },
      annotations: ACTION,
    },
    async ({ action, index, url }, session) => {
      switch (action) {
        case 'list':
          return listTabs(session);
        case 'new': {
          const page = await session.newTab(url ? normalizeUrl(url) : undefined);
          return pageResult(session, page, `Opened a new tab at index ${session.tabIndex(page)}; it is now active.`, {
            snapshot: Boolean(url),
          });
        }
        case 'select': {
          if (index === undefined) throw new UserError('"index" is required for action "select".');
          const page = await session.selectTab(index);
          return pageResult(session, page, `Switched to tab ${index}.`);
        }
        case 'close': {
          await session.closeTab(index);
          return `Closed tab${index === undefined ? '' : ` ${index}`}.\n\n${await listTabs(session)}`;
        }
      }
    },
  );

  tool(
    'browser_resize',
    {
      title: 'Resize viewport',
      description: 'Resize the browser viewport of the active tab (e.g. to test a mobile layout).',
      input: {
        width: z.number().int().min(100).max(10_000).describe('Viewport width in CSS pixels.'),
        height: z.number().int().min(100).max(10_000).describe('Viewport height in CSS pixels.'),
      },
      annotations: ACTION,
    },
    async ({ width, height }, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      await page.setViewportSize({ width, height });
      return `Viewport resized to ${width}x${height}.`;
    },
  );

  tool(
    'browser_close',
    {
      title: 'Close browser',
      description:
        'Close the browser and all its tabs. Call this when a browsing task is finished; the browser relaunches automatically on the next browser tool call.',
      input: {},
      annotations: { ...READ_ONLY, readOnlyHint: false, destructiveHint: true },
    },
    async (_args, session) => {
      if (!session.running) return 'The browser is not running.';
      await session.close();
      return 'Browser closed. It will relaunch on the next browser tool call.';
    },
  );
}
