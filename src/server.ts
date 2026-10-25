import { McpServer } from '@modelcontextprotocol/server';
import type { BrowserSession } from './browser.js';
import { VERSION } from './config.js';
import type { HandoffBroker } from './handoff.js';
import { createRegistrar, type RegistrarHooks, type ToolRegistrar } from './tools/common.js';
import { registerHandoffTools } from './tools/handoff.js';
import { registerInspectionTools } from './tools/inspect.js';
import { registerInteractionTools } from './tools/interact.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerTabTools } from './tools/tabs.js';

/**
 * Which tools a server exposes.
 * - full: every tool, for coding agents (Claude Code, Codex, Cursor, ...).
 * - lite: the chat-oriented subset with text-only results, no file paths and no
 *   scripting. It stays within the 20-tool limit that directories such as PlayMCP
 *   impose and leaves out tools whose results a chat UI cannot show (screenshots).
 */
export type ToolProfile = 'full' | 'lite';

export const LITE_TOOLS: ReadonlySet<string> = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_snapshot',
  'browser_get_text',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_hover',
  'browser_scroll',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_tabs',
  'browser_close',
  'browser_request_human',
]);

const REMOTE_NOTES = [
  'This browser runs on a shared remote server:',
  '- Only public web sites can be opened. Local files and private network addresses are refused.',
  '- Nobody can see the browser window. If a site needs a human to log in, solve a CAPTCHA or pass a "verify you are human" check, call browser_request_human and give the person the link instead of guessing credentials or trying to solve it. Keep that tab open (no browser_close, no navigating away) until the person says they are done.',
  '- Logins (cookies) are kept for you between sessions.',
];

const REMOTE_FILE_NOTE =
  '- File paths for browser_file_upload and browser_screenshot savePath are relative to your private workspace on the server; downloads are saved there as well.';

const LITE_NOTE =
  'This endpoint offers the chat subset of the tools: no screenshots, scripting, file uploads or network inspection. Describe pages from the snapshot text.';

function instructionsFor(profile: ToolProfile, remote: boolean): string {
  const readStep =
    profile === 'lite'
      ? '3. Use browser_snapshot to re-read the page and browser_get_text to read long content.'
      : '3. Use browser_snapshot to re-read the page, browser_get_text to read long content, and browser_screenshot only when the visual layout matters.';
  const parts = [
    `browser-mcp drives a real browser through Playwright.

Workflow:
1. browser_navigate to open a page. The result contains an accessibility snapshot in which every element has a ref such as [ref=e12].
2. Interact with elements by passing that ref to browser_click, browser_type, browser_select_option, browser_hover, etc. Every action returns the updated snapshot, so refs from the latest result are the ones to use.
${readStep}
4. If a result reports an open dialog, call browser_handle_dialog before anything else. If a result reports a new tab, switch with browser_tabs.
5. Call browser_close when the browsing task is finished.`,
  ];
  if (remote) parts.push([...REMOTE_NOTES, ...(profile === 'full' ? [REMOTE_FILE_NOTE] : [])].join('\n'));
  if (profile === 'lite') parts.push(LITE_NOTE);
  return parts.join('\n\n');
}

export interface ServerOptions extends RegistrarHooks {
  /** Add the notes that apply when the browser runs on a shared remote machine. */
  remote?: boolean;
  /** Tool set to expose (default: full). */
  profile?: ToolProfile;
  /** Enables browser_request_human (remote mode only: the person needs an HTTP endpoint to look at). */
  handoff?: HandoffBroker;
}

export function createServer(session: BrowserSession, options: ServerOptions = {}): McpServer {
  const profile = options.profile ?? 'full';
  const server = new McpServer({ name: 'browser-mcp', version: VERSION }, { instructions: instructionsFor(profile, options.remote === true) });
  const register = createRegistrar(server, session, { onToolCall: options.onToolCall });
  const tool: ToolRegistrar = (name, spec, handler) => {
    if (profile === 'lite' && !LITE_TOOLS.has(name)) return;
    register(name, spec, handler);
  };
  registerNavigationTools(tool);
  registerInspectionTools(tool);
  registerInteractionTools(tool);
  registerTabTools(tool);
  if (options.handoff) registerHandoffTools(tool, options.handoff);
  return server;
}
