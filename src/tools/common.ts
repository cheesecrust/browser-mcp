import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import type { Page } from 'playwright';
import * as z from 'zod/v4';
import { UserError, type BrowserSession } from '../browser.js';
import { describePage, type DescribeOptions } from '../snapshot.js';

export type ToolResult = CallToolResult;

export interface ToolSpec<Shape extends z.ZodRawShape> {
  title: string;
  description: string;
  input: Shape;
  annotations?: ToolAnnotations;
}

export type ToolHandler<Shape extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<Shape>>,
  session: BrowserSession,
) => Promise<ToolResult | string>;

export type ToolRegistrar = <Shape extends z.ZodRawShape>(
  name: string,
  spec: ToolSpec<Shape>,
  handler: ToolHandler<Shape>,
) => void;

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const ACTION: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/** Input fields shared by every tool that targets an element. */
export const targetInput = {
  ref: z
    .string()
    .optional()
    .describe('Element ref from the most recent snapshot, e.g. "e12" or "f3e12" (copy it exactly as shown). Preferred over selector.'),
  selector: z
    .string()
    .optional()
    .describe(
      'Playwright selector used when no ref is given: CSS ("#email", "button.primary"), text ("text=Sign in"), role ("role=button[name=\'Submit\']") or xpath ("xpath=//h1"). Must match exactly one element.',
    ),
};

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function formatError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
  return cleaned.length > 1_500 ? `${cleaned.slice(0, 1_500)}...` : cleaned;
}

export function errorResult(error: unknown): ToolResult {
  const message = error instanceof UserError ? error.message : formatError(error);
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

export interface ToolCallInfo {
  name: string;
  /** Wall-clock duration in milliseconds. */
  ms: number;
  ok: boolean;
  /** URL of the active tab after the call, when a browser is running. */
  url?: string | undefined;
}

export interface RegistrarHooks {
  /** Called after every tool call, e.g. to write an audit log line. */
  onToolCall?: (info: ToolCallInfo) => void;
}

export function createRegistrar(server: McpServer, session: BrowserSession, hooks: RegistrarHooks = {}): ToolRegistrar {
  return (name, spec, handler) => {
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: z.object(spec.input),
        // Directories such as PlayMCP expect the title inside annotations as well.
        annotations: { title: spec.title, ...spec.annotations },
      },
      async (args) =>
        // One call at a time per browser, even when several sessions share it.
        session.mutex.run(async () => {
          const started = Date.now();
          let ok = false;
          try {
            const result = await handler(args as Parameters<typeof handler>[0], session);
            const toolResult = typeof result === 'string' ? textResult(result) : result;
            ok = toolResult.isError !== true;
            return toolResult;
          } catch (error) {
            return errorResult(error);
          } finally {
            // Logins and other state changes are saved to the user's state file (shared servers).
            session.schedulePersist();
            hooks.onToolCall?.({ name, ms: Date.now() - started, ok, url: session.activeUrl() });
          }
        }),
    );
  };
}

export interface ResultOptions extends DescribeOptions {
  /** Tabs that existed before the action; any tab not in this list is reported as newly opened. */
  tabsBefore?: Page[];
}

/**
 * Gives the page a moment to finish a navigation the action may have started, and
 * popups a moment to be reported by the browser.
 */
export async function settle(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(100).catch(() => undefined);
}

/** `message` followed by the page description (title, URL, tabs, dialog, snapshot). */
export async function pageResult(
  session: BrowserSession,
  page: Page,
  message: string,
  options: ResultOptions = {},
): Promise<ToolResult> {
  const fixedNotes = typeof options.notes === 'function' ? options.notes() : [...(options.notes ?? [])];
  let current = page;
  if (current.isClosed()) {
    current = await session.page();
    fixedNotes.push(`The previous tab was closed; now on tab ${session.tabIndex(current)}.`);
  }
  // Evaluated after the snapshot is captured so that a popup opened by the action is included.
  const notes = (): string[] => {
    const lines = [...fixedNotes];
    if (options.tabsBefore) {
      for (const tab of session.tabs()) {
        if (!options.tabsBefore.includes(tab)) {
          lines.push(
            `New tab opened at index ${session.tabIndex(tab)}: ${tab.url()} (switch with browser_tabs action "select").`,
          );
        }
      }
    }
    return lines;
  };
  const description = await describePage(session, current, { ...options, notes });
  return textResult(`${message}\n\n${description}`);
}

/**
 * Runs an interaction on the active page: refuses while a dialog is open, returns
 * early when the action itself opens a dialog, then reports the resulting page.
 */
export async function performAction(
  session: BrowserSession,
  page: Page,
  message: string,
  action: () => Promise<unknown>,
  options: ResultOptions = {},
): Promise<ToolResult> {
  session.assertNoDialog(page);
  const tabsBefore = session.tabs();
  const outcome = await session.raceDialog(page, action());
  if ('dialog' in outcome) {
    return pageResult(session, page, `${message} A dialog opened as a result.`, { ...options, snapshot: false, tabsBefore });
  }
  await settle(page);
  return pageResult(session, page, message, { ...options, tabsBefore });
}

export function clampText(text: string, maxChars: number, offset = 0): { slice: string; note: string } {
  const start = Math.min(Math.max(offset, 0), text.length);
  const slice = text.slice(start, start + maxChars);
  const end = start + slice.length;
  const note =
    end < text.length
      ? `Showing characters ${start}-${end} of ${text.length}. Call again with offset=${end} to continue.`
      : start > 0
        ? `Showing characters ${start}-${end} of ${text.length} (end).`
        : `${text.length} characters.`;
  return { slice, note };
}
