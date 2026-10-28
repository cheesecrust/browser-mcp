import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from './log.js';

/**
 * Bearer tokens issued by the server itself through POST /tokens. The token itself is
 * kept (mode 0600) so GET /tokens can show it again; this store is meant for sandboxes
 * where an administrator hands tokens out and needs to look them up later.
 */

export interface IssuedToken {
  token: string;
  /** Workspace name; unique among issued tokens. */
  user: string;
  createdAt: string;
}

interface PersistedState {
  tokens: Array<IssuedToken & { hash: string }>;
}

export class IssueError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'IssueError';
  }
}

const USER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN_PREFIX = 'bmt_';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export class IssuedTokenStore {
  private readonly byHash = new Map<string, IssuedToken>();
  private readonly hashByUser = new Map<string, string>();

  constructor(private readonly statePath: string) {}

  get size(): number {
    return this.byHash.size;
  }

  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch {
      return;
    }
    try {
      const state = JSON.parse(text) as PersistedState;
      for (const { hash, ...record } of state.tokens ?? []) {
        this.byHash.set(hash, record);
        this.hashByUser.set(record.user, hash);
      }
      log(`loaded ${this.byHash.size} issued token(s)`);
    } catch (error) {
      log(`could not read ${this.statePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Returns the user a token was issued to, or undefined for unknown tokens. */
  userFor(token: string): string | undefined {
    return this.byHash.get(sha256(token))?.user;
  }

  /** Every issued token, oldest first, including the token itself. */
  list(): IssuedToken[] {
    return [...this.byHash.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Issues a fresh random token. With `user` the workspace gets that name (which must be
   * unused); otherwise a unique generated name is assigned. The token is persisted before
   * it is returned so a restart cannot forget it.
   */
  async issue(user?: string): Promise<IssuedToken> {
    let name: string;
    if (user !== undefined) {
      name = user.trim();
      if (!USER_NAME.test(name)) {
        throw new IssueError(400, 'user must be 1-64 letters, digits, ".", "_" or "-" and start with a letter or digit');
      }
      if (this.hashByUser.has(name)) throw new IssueError(409, `a token for user "${name}" was already issued; revoke it first`);
    } else {
      do name = `user-${randomBytes(4).toString('hex')}`;
      while (this.hashByUser.has(name));
    }
    let token: string;
    let hash: string;
    do {
      token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
      hash = sha256(token);
    } while (this.byHash.has(hash));
    const record: IssuedToken = { token, user: name, createdAt: new Date().toISOString() };
    this.byHash.set(hash, record);
    this.hashByUser.set(name, hash);
    await this.persist();
    return record;
  }

  /** Forgets the token issued to `user`; returns false when there is none. */
  async revoke(user: string): Promise<boolean> {
    const hash = this.hashByUser.get(user);
    if (!hash) return false;
    this.hashByUser.delete(user);
    this.byHash.delete(hash);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      tokens: [...this.byHash.entries()].map(([hash, record]) => ({ hash, ...record })),
    };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}
