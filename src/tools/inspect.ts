import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { describeTarget, type ConsoleEntry, type NetworkEntry } from '../browser.js';
import { ACTION, READ_ONLY, clampText, pageResult, targetInput, textResult, type ToolRegistrar } from './common.js';

const MAX_RESULT_CHARS = 20_000;
const MAX_PNG_BYTES = 4_000_000;

/** Runs agent-supplied JavaScript inside the page. Functions are called (with the element, if any). */
const evaluateInPage = (arg: { source: string }): unknown => {
  const value = (0, eval)(arg.source) as unknown;
  return typeof value === 'function' ? (value as () => unknown)() : value;
};
const evaluateOnElement = (element: Element, arg: { source: string }): unknown => {
  const value = (0, eval)(arg.source) as unknown;
  return typeof value === 'function' ? (value as (el: Element) => unknown)(element) : value;
};

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

function formatConsole(entries: ConsoleEntry[]): string {
  return entries
    .map(
      (entry) =>
        `[${formatTime(entry.timestamp)}] ${entry.type.toUpperCase()}: ${entry.text}${entry.location ? ` (${entry.location})` : ''}`,
    )
    .join('\n');
}

function formatNetwork(entries: NetworkEntry[]): string {
  return entries
    .map((entry) => {
      const outcome = entry.failure
        ? `FAILED ${entry.failure}`
        : entry.status === undefined
          ? 'pending'
          : String(entry.status);
      return `[${formatTime(entry.timestamp)}] ${entry.method} ${entry.url} -> ${outcome} [${entry.resourceType}]`;
    })
    .join('\n');
}

export function registerInspectionTools(tool: ToolRegistrar): void {
  tool(
    'browser_snapshot',
    {
      title: 'Page snapshot',
      description:
        'Capture the accessibility snapshot of the current page (or of one element). Every element gets a ref like [ref=e12] that other tools accept. This is the primary way to read a page; prefer it over screenshots unless layout matters.',
      input: {
        ...targetInput,
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Truncate the snapshot beyond this many characters (default: server setting).'),
      },
      annotations: READ_ONLY,
    },
    async ({ ref, selector, maxChars }, session) => {
      const page = await session.page();
      return pageResult(session, page, 'Snapshot captured.', { ref, selector, maxChars });
    },
  );

  tool(
    'browser_screenshot',
    {
      title: 'Screenshot',
      description:
        'Take a screenshot of the viewport, the full page, or one element, and return it as an image. Use it when visual appearance matters; use browser_snapshot to read structure and text.',
      input: {
        ...targetInput,
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole scrollable page instead of the viewport (ignored for element screenshots).'),
        type: z.enum(['png', 'jpeg']).optional().describe('Image format (default png).'),
        quality: z.number().int().min(0).max(100).optional().describe('JPEG quality 0-100 (default 80; jpeg only).'),
        savePath: z
          .string()
          .optional()
          .describe('Also write the image to this file path (on a shared server: relative to your workspace).'),
      },
      annotations: READ_ONLY,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const targeted = Boolean(args.ref || args.selector);
      const savePath = args.savePath ? session.resolvePath(args.savePath, 'screenshots') : undefined;
      if (savePath) await mkdir(path.dirname(savePath), { recursive: true });
      const capture = async (type: 'png' | 'jpeg', quality: number | undefined): Promise<Buffer> => {
        const options = { type, quality: type === 'jpeg' ? quality : undefined, scale: 'css' as const, path: savePath };
        return targeted
          ? session.resolveTarget(page, args).screenshot(options)
          : page.screenshot({ ...options, fullPage: args.fullPage ?? false });
      };
      let type = args.type ?? 'png';
      let buffer = await capture(type, args.quality ?? 80);
      let sizeNote = '';
      if (type === 'png' && buffer.length > MAX_PNG_BYTES) {
        // Very large PNGs (long full-page captures) are re-taken as JPEG to keep the result small.
        type = 'jpeg';
        buffer = await capture(type, 70);
        sizeNote = ' (re-encoded as JPEG because the PNG was too large)';
      }
      const title = await page.title().catch(() => '');
      const what = targeted ? describeTarget(args) : args.fullPage ? 'the full page' : 'the viewport';
      const text =
        `Screenshot of ${what} (${type}, ${Math.max(1, Math.round(buffer.length / 1024))} KB${sizeNote}` +
        `${savePath ? `, saved to ${session.displayPath(savePath)}` : ''}). Page: ${title || '(no title)'} - ${page.url()}`;
      return {
        content: [
          { type: 'image', data: buffer.toString('base64'), mimeType: `image/${type}` },
          { type: 'text', text },
        ],
      };
    },
  );

  tool(
    'browser_get_text',
    {
      title: 'Get text',
      description:
        'Return the visible text (innerText) of the page or of one element. Best for reading articles, tables or long content. Large texts are paged with offset.',
      input: {
        ...targetInput,
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Maximum characters to return (default ${MAX_RESULT_CHARS}).`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Start at this character offset (for paging through long text).'),
      },
      annotations: READ_ONLY,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const targeted = Boolean(args.ref || args.selector);
      const locator = targeted ? session.resolveTarget(page, args) : page.locator('body');
      const text = (await locator.innerText()).trim();
      const { slice, note } = clampText(text, args.maxChars ?? MAX_RESULT_CHARS, args.offset ?? 0);
      const what = targeted ? describeTarget(args) : 'the page';
      return `Text of ${what} (${note})\n\n${slice}`;
    },
  );

  tool(
    'browser_evaluate',
    {
      title: 'Run JavaScript',
      description:
        'Run JavaScript in the page and return the JSON-serialized result. "expression" may be an expression ("document.title") or a function ("() => location.href", "async () => ..."). When ref or selector is given, the function receives that element as its first argument, e.g. "(el) => el.value".',
      input: {
        expression: z.string().describe('JavaScript expression or function source to run in the page.'),
        ...targetInput,
      },
      annotations: ACTION,
    },
    async (args, session) => {
      const page = await session.page();
      session.assertNoDialog(page);
      const source = args.expression.trim();
      const targeted = Boolean(args.ref || args.selector);
      const outcome = await session.raceDialog(
        page,
        targeted
          ? session.resolveTarget(page, args).evaluate(evaluateOnElement, { source })
          : page.evaluate(evaluateInPage, { source }),
      );
      if ('dialog' in outcome) {
        return pageResult(session, page, 'The script opened a dialog before returning.', { snapshot: false });
      }
      const { slice, note } = clampText(formatValue(outcome.value), MAX_RESULT_CHARS);
      return `Result (${note}):\n${slice}`;
    },
  );

  tool(
    'browser_console_messages',
    {
      title: 'Console messages',
      description:
        'Return console output and uncaught errors recorded for the active tab since it was opened (or since the last clear).',
      input: {
        level: z
          .enum(['all', 'warning', 'error'])
          .optional()
          .describe('Minimum level to include: "all" (default), "warning" (warnings and errors) or "error".'),
        clear: z.boolean().optional().describe('Clear the recorded messages after returning them.'),
      },
      annotations: READ_ONLY,
    },
    async ({ level, clear }, session) => {
      const page = await session.page();
      const all = session.consoleEntries(page);
      const wanted =
        level === 'error'
          ? all.filter((e) => e.type === 'error' || e.type === 'assert')
          : level === 'warning'
            ? all.filter((e) => e.type === 'error' || e.type === 'assert' || e.type === 'warning')
            : all;
      if (clear) session.clearConsole(page);
      if (wanted.length === 0) {
        return `No console messages${level && level !== 'all' ? ` at level ${level} or above` : ''}.`;
      }
      const { slice, note } = clampText(formatConsole(wanted), MAX_RESULT_CHARS);
      return textResult(`${wanted.length} console message${wanted.length === 1 ? '' : 's'} (${note})\n${slice}`);
    },
  );

  tool(
    'browser_network_requests',
    {
      title: 'Network requests',
      description:
        'Return the network requests made by the active tab (method, URL, status, resource type), most recent last.',
      input: {
        filter: z.string().optional().describe('Only include requests whose URL contains this text (case-insensitive).'),
        clear: z.boolean().optional().describe('Clear the recorded requests after returning them.'),
      },
      annotations: READ_ONLY,
    },
    async ({ filter, clear }, session) => {
      const page = await session.page();
      const all = session.networkEntries(page);
      const needle = filter?.toLowerCase();
      const wanted = needle ? all.filter((e) => e.url.toLowerCase().includes(needle)) : all;
      if (clear) session.clearNetwork(page);
      if (wanted.length === 0) {
        return `No network requests recorded${filter ? ` matching ${JSON.stringify(filter)}` : ''}.`;
      }
      const { slice, note } = clampText(formatNetwork(wanted), MAX_RESULT_CHARS);
      return textResult(`${wanted.length} request${wanted.length === 1 ? '' : 's'} (${note})\n${slice}`);
    },
  );
}
