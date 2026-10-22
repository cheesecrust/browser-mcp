#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { BrowserSession } from './browser.js';
import { type Config, ConfigError, parseConfig, USAGE, VERSION } from './config.js';
import { startHttpServer } from './http.js';
import { log } from './log.js';
import { createServer } from './server.js';

function describeBrowser(config: Config): string {
  return `${config.browser}${config.channel ? `/${config.channel}` : ''}, ${config.headless ? 'headless' : 'headed'}, ${
    config.viewport.width
  }x${config.viewport.height}`;
}

function onSignals(shutdown: (reason: string) => void): void {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

function runStdio(config: Config): void {
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

  onSignals((reason) => void shutdown(reason));
  log(`v${VERSION} listening on stdio (${describeBrowser(config)})`);
}

async function runHttp(config: Config): Promise<void> {
  log(`v${VERSION} starting in HTTP mode (${describeBrowser(config)})`);
  const handle = await startHttpServer(config);

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    // A stuck browser must not keep the process alive forever.
    const forced = setTimeout(() => process.exit(0), 10_000);
    forced.unref();
    await handle.close().catch(() => undefined);
    process.exit(0);
  };
  onSignals((reason) => void shutdown(reason));
}

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
  if (config.http) {
    runHttp(config).catch((error: unknown) => {
      process.stderr.write(`browser-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
    return;
  }
  runStdio(config);
}

main();
