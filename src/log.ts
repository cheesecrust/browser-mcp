/**
 * All diagnostics go to stderr: stdout is the JSON-RPC channel of the MCP
 * stdio transport and must never receive anything else.
 */
export function log(message: string, ...rest: unknown[]): void {
  console.error(`[browser-mcp] ${message}`, ...rest);
}
