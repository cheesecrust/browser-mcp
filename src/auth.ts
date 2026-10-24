import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ConfigError } from './errors.js';

/** A static bearer token that identifies one user of a shared server. */
export interface TokenEntry {
  token: string;
  user: string;
}

const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateEntry(entry: TokenEntry, source: string): TokenEntry {
  const token = entry.token.trim();
  const user = entry.user.trim();
  if (token.length < 16) throw new ConfigError(`${source}: token for user "${user}" is too short (use at least 16 characters)`);
  if (!USER_NAME.test(user)) {
    throw new ConfigError(`${source}: user name "${user}" must be 1-64 letters, digits, ".", "_" or "-" and start with a letter or digit`);
  }
  return { token, user };
}

/**
 * Parses a tokens file. Two layouts are accepted:
 *   { "<token>": "<user>", ... }
 *   { "tokens": [ { "token": "<token>", "user": "<user>" }, ... ] }
 */
export function parseTokensJson(text: string, source: string): TokenEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!data || typeof data !== 'object') throw new ConfigError(`${source}: expected a JSON object`);
  const record = data as Record<string, unknown>;
  const entries: TokenEntry[] = [];
  if (Array.isArray(record.tokens)) {
    for (const item of record.tokens) {
      if (!item || typeof item !== 'object') throw new ConfigError(`${source}: every entry in "tokens" must be an object`);
      const { token, user } = item as Record<string, unknown>;
      if (typeof token !== 'string' || typeof user !== 'string') {
        throw new ConfigError(`${source}: every entry in "tokens" needs string "token" and "user" fields`);
      }
      entries.push(validateEntry({ token, user }, source));
    }
  } else {
    for (const [token, user] of Object.entries(record)) {
      if (typeof user !== 'string') throw new ConfigError(`${source}: the value for each token must be the user name (a string)`);
      entries.push(validateEntry({ token, user }, source));
    }
  }
  return entries;
}

/** Parses the BROWSER_MCP_TOKENS form: "token1:alice,token2:bob". */
export function parseTokensEnv(value: string): TokenEntry[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.lastIndexOf(':');
      if (separator <= 0) throw new ConfigError(`BROWSER_MCP_TOKENS: expected "token:user" entries (got "${part}")`);
      return validateEntry({ token: part.slice(0, separator), user: part.slice(separator + 1) }, 'BROWSER_MCP_TOKENS');
    });
}

export function loadTokens(tokensFile: string | undefined, envValue: string | undefined): TokenEntry[] {
  const entries: TokenEntry[] = [];
  if (tokensFile) {
    let text: string;
    try {
      text = readFileSync(tokensFile, 'utf8');
    } catch (error) {
      throw new ConfigError(`--tokens-file ${tokensFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    entries.push(...parseTokensJson(text, tokensFile));
  }
  if (envValue && envValue.trim()) entries.push(...parseTokensEnv(envValue));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.token)) throw new ConfigError(`duplicate token configured for user "${entry.user}"`);
    seen.add(entry.token);
  }
  return entries;
}

/** Looks up bearer tokens without leaking which byte of a wrong token differed. */
export class TokenStore {
  private readonly byToken = new Map<string, string>();

  constructor(entries: readonly TokenEntry[]) {
    for (const entry of entries) this.byToken.set(entry.token, entry.user);
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Returns the user that owns `token`, or undefined. */
  userFor(token: string): string | undefined {
    const candidate = Buffer.from(token);
    for (const [known, user] of this.byToken) {
      const expected = Buffer.from(known);
      if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) return user;
    }
    return undefined;
  }

  /** Extracts and verifies the token of an `Authorization: Bearer ...` header value. */
  authenticate(authorization: string | undefined): string | undefined {
    if (!authorization) return undefined;
    const match = /^\s*(?:Bearer\s+)?(\S+)\s*$/i.exec(authorization);
    if (!match) return undefined;
    return this.userFor(match[1]!);
  }
}
