import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { log } from './log.js';

/**
 * Network policy for servers that are reachable by other people: the browser may
 * only talk to public hosts. Local files, browser-internal pages, loopback,
 * private, link-local (cloud metadata) and multicast addresses are refused, and
 * host names are resolved first so a public name pointing at a private address
 * (DNS rebinding) is refused as well.
 */

const BLOCKED_SCHEMES = /^(file|chrome|chrome-extension|chrome-untrusted|devtools|view-source|edge|about):/i;
const ALLOWED_ABOUT = new Set(['about:blank', 'about:srcdoc']);

/** Schemes that must never be opened on a shared server. `about:blank` stays allowed. */
export function isBlockedScheme(url: string): boolean {
  const trimmed = url.trim();
  if (ALLOWED_ABOUT.has(trimmed.toLowerCase())) return false;
  return BLOCKED_SCHEMES.test(trimmed);
}

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

const PRIVATE_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata services
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToNumber(ip);
  if (value === undefined) return true;
  return PRIVATE_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToNumber(base)! & mask);
  });
}

/** Expands an IPv6 address to its eight 16-bit groups. */
function expandV6(ip: string): number[] | undefined {
  let address = ip;
  // Embedded IPv4 (e.g. ::ffff:10.0.0.1) is turned into two hex groups.
  const v4Match = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4Match) {
    const v4 = ipv4ToNumber(v4Match[2]!);
    if (v4 === undefined) return undefined;
    address = `${v4Match[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function isPrivateV6(ip: string): boolean {
  const groups = expandV6(ip);
  if (!groups) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses defer to the IPv4 rules.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
    return isPrivateV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return isPrivateV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`); // NAT64
  return false;
}

/** True for loopback, private, link-local, multicast and otherwise non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true;
}

/** Host names that always refer to the local machine or the local network. */
export function isLocalHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name === '' || name === 'metadata' ||
    name === 'metadata.google.internal' || name.endsWith('.internal');
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

interface CacheEntry {
  addresses: string[];
  expires: number;
}

/**
 * Decides whether the browser may fetch a URL. Resolution results are cached
 * briefly so the per-request check stays cheap.
 */
export class UrlGuard {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly resolver: Resolver = defaultResolver,
    private readonly cacheTtlMs = 60_000,
  ) {}

  /** Returns a reason when `url` must not be fetched, or undefined when it is allowed. */
  async check(url: string): Promise<string | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'the URL is not valid';
    }
    if (isBlockedScheme(parsed.href)) return `${parsed.protocol} URLs are not allowed on this server`;
    if (!/^(https?|wss?|data|blob|about):$/.test(parsed.protocol)) return `${parsed.protocol} URLs are not allowed on this server`;
    if (!/^(https?|wss?):$/.test(parsed.protocol)) return undefined;

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isLocalHostname(hostname)) return `${hostname} is a local address; only public web sites can be opened`;
    if (isIP(hostname)) {
      return isPrivateAddress(hostname) ? `${hostname} is a private or reserved address; only public web sites can be opened` : undefined;
    }

    let addresses: string[];
    try {
      addresses = await this.resolve(hostname);
    } catch {
      return `${hostname} could not be resolved`;
    }
    if (addresses.length === 0) return `${hostname} could not be resolved`;
    const privateAddress = addresses.find((address) => isPrivateAddress(address));
    if (privateAddress) {
      return `${hostname} resolves to ${privateAddress}, a private or reserved address; only public web sites can be opened`;
    }
    return undefined;
  }

  private async resolve(hostname: string): Promise<string[]> {
    const key = hostname.toLowerCase();
    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.addresses;
    const addresses = await this.resolver(key);
    this.cache.set(key, { addresses, expires: now + this.cacheTtlMs });
    if (this.cache.size > 2_000) {
      for (const [entryKey, entry] of this.cache) {
        if (entry.expires <= now) this.cache.delete(entryKey);
      }
    }
    return addresses;
  }
}

/** Logs a refused request once per URL prefix so a page full of blocked assets does not flood the log. */
export function logBlocked(reason: string, url: string, seen: Set<string>): void {
  const key = url.slice(0, 120);
  if (seen.has(key)) return;
  seen.add(key);
  log(`blocked ${url.slice(0, 200)}: ${reason}`);
}
