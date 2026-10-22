#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BrowserSession } from './browser.js';
import { ConfigError, parseConfig, USAGE, VERSION } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';

function main(): void {
  let parsed;
  try {
    parsed = parseConfig(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`browser-mcp: ${message}\nRun with --help for usage.\n`);
    process.exit(2);
  }
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (parsed.kind === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const { config } = parsed;
  const session = new BrowserSession(config);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    await session.close();
    await handle.close().catch(() => undefined);
    process.exit(0);
  };

  const handle = serveStdio(
    () => {
      const server = createServer(session);
      // stdin EOF means the host is gone: close the browser so no window is left behind.
      server.server.onclose = () => void shutdown('client disconnected');
      return server;
    },
    { onerror: (error) => log(`transport error: ${error.message}`) },
  );

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));

  log(
    `v${VERSION} listening on stdio (${config.browser}${config.channel ? `/${config.channel}` : ''}, ${
      config.headless ? 'headless' : 'headed'
    }, ${config.viewport.width}x${config.viewport.height})`,
  );
}

main();
