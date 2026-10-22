import { McpServer } from '@modelcontextprotocol/server';
import type { BrowserSession } from './browser.js';
import { VERSION } from './config.js';
import { createRegistrar, type RegistrarHooks } from './tools/common.js';
import { registerInspectionTools } from './tools/inspect.js';
import { registerInteractionTools } from './tools/interact.js';
import { registerNavigationTools } from './tools/navigation.js';
import { registerTabTools } from './tools/tabs.js';

const INSTRUCTIONS = `browser-mcp drives a real browser through Playwright.

Workflow:
1. browser_navigate to open a page. The result contains an accessibility snapshot in which every element has a ref such as [ref=e12].
2. Interact with elements by passing that ref to browser_click, browser_type, browser_select_option, browser_hover, etc. Every action returns the updated snapshot, so refs from the latest result are the ones to use.
3. Use browser_snapshot to re-read the page, browser_get_text to read long content, and browser_screenshot only when the visual layout matters.
4. If a result reports an open dialog, call browser_handle_dialog before anything else. If a result reports a new tab, switch with browser_tabs.
5. Call browser_close when the browsing task is finished.`;

const REMOTE_NOTES = `This browser runs on a shared remote server:
- Only public web sites can be opened. Local files and private network addresses are refused.
- Nobody can see the browser window. If a site needs a human to log in or solve a challenge, say so instead of guessing credentials.
- File paths for browser_file_upload and browser_screenshot savePath are relative to your private workspace on the server; downloads are saved there as well.
- Logins (cookies) are kept for you between sessions.`;

export interface ServerOptions extends RegistrarHooks {
  /** Add the notes that apply when the browser runs on a shared remote machine. */
  remote?: boolean;
}

export function createServer(session: BrowserSession, options: ServerOptions = {}): McpServer {
  const instructions = options.remote ? `${INSTRUCTIONS}\n\n${REMOTE_NOTES}` : INSTRUCTIONS;
  const server = new McpServer({ name: 'browser-mcp', version: VERSION }, { instructions });
  const tool = createRegistrar(server, session, { onToolCall: options.onToolCall });
  registerNavigationTools(tool);
  registerInspectionTools(tool);
  registerInteractionTools(tool);
  registerTabTools(tool);
  return server;
}
