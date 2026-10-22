import * as z from 'zod/v4';
import { normalizeUrl } from '../browser.js';
import { ACTION, pageResult, type ToolRegistrar } from './common.js';

export function registerNavigationTools(tool: ToolRegistrar): void {
  tool(
    'browser_navigate',
    {
      title: 'Navigate to URL',
      description:
        'Open a URL in the active tab and return the page\'s accessibility snapshot. Launches the browser on first use. Start every browsing task with this tool.',
      input: {
        url: z
          .string()
          .describe('Absolute URL such as "https://example.com". "https://" is added when the scheme is missing.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
          .optional()
          .describe('Event that marks the navigation as finished (default "load"). Use "domcontentloaded" for slow pages.'),
      },
      annotations: ACTION,
    },
    async ({ url, waitUntil }, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const target = normalizeUrl(url);
      const tabsBefore = session.tabs();
      // A page that shows an alert while loading never fires "load"; report the dialog instead of timing out.
      const outcome = await session.raceDialog(page, page.goto(target, { waitUntil: waitUntil ?? 'load' }));
      if ('dialog' in outcome) {
        return pageResult(session, page, `Navigating to ${target} opened a dialog before the page finished loading.`, {
          snapshot: false,
          tabsBefore,
        });
      }
      const status = outcome.value ? ` (HTTP ${outcome.value.status()})` : '';
      return pageResult(session, page, `Navigated to ${page.url()}${status}.`, { tabsBefore });
    },
  );

  tool(
    'browser_navigate_back',
    {
      title: 'Go back',
      description: 'Go back to the previous page in the active tab\'s history and return the snapshot.',
      input: {},
      annotations: ACTION,
    },
    async (_args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const before = page.url();
      const response = await page.goBack();
      if (response === null && page.url() === before) {
        return pageResult(session, page, 'There is no previous page in the history; still on the same page.', {
          snapshot: false,
        });
      }
      return pageResult(session, page, `Went back to ${page.url()}.`);
    },
  );

  tool(
    'browser_navigate_forward',
    {
      title: 'Go forward',
      description: 'Go forward to the next page in the active tab\'s history and return the snapshot.',
      input: {},
      annotations: ACTION,
    },
    async (_args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const before = page.url();
      const response = await page.goForward();
      if (response === null && page.url() === before) {
        return pageResult(session, page, 'There is no next page in the history; still on the same page.', {
          snapshot: false,
        });
      }
      return pageResult(session, page, `Went forward to ${page.url()}.`);
    },
  );
}
