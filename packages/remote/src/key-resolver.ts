import { isIP } from 'node:net';
import type { ConnectionIdentity } from './auth.js';

/** Maps a verified connection to the EvoLink key that pays for its calls. */
export interface KeyResolver {
  resolve(identity: ConnectionIdentity): Promise<string>;
}

/** The connection has no usable key right now; the message is shown to the agent. */
export class KeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyUnavailableError';
  }
}

/** Used when no key endpoint is configured: paid tools fail clearly and nothing is sent upstream. */
export const unconfiguredKeyResolver: KeyResolver = {
  async resolve(): Promise<string> {
    throw new KeyUnavailableError(
      'EvoLink account access for MCP connections is not enabled on this server yet. No request was sent and nothing was charged.',
    );
  },
};

const RECONNECT =
  'This EvoLink connection is no longer active (it was revoked, expired, or signed out). Ask the user to reconnect EvoLink in this client. Nothing was charged.';

/** Gateway answers that mean the connection itself is gone, not that the lookup failed. */
const CONNECTION_GONE = new Set(['connection_not_found', 'connection_revoked', 'session_inactive', 'session_expired']);

export interface GatewayKeyResolverOptions {
  /** Gateway endpoint that returns the MCP key of one Passport session (internal network). */
  endpoint: string;
  /** Credential that identifies this MCP service to the gateway. */
  serviceToken: string;
  /** How long a fetched key is reused before asking again (default 5 minutes). */
  cacheTtlMs?: number;
  /** Bound on cached connections; the oldest are dropped first. */
  maxEntries?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

interface CachedKey {
  key: string;
  until: number;
}

/**
 * Key custody option C: the MCP key is stored encrypted in the gateway; this
 * service fetches it per connection with its own service credential and keeps
 * it only in memory. Contract (gateway side to be built):
 *
 *   POST <endpoint>
 *   Authorization: Bearer <service token>
 *   {"subject": "<Passport sub>", "session_id": "<Passport sid>", "client_id": "<OAuth client>"}
 *
 *   200 {"key": "sk-…", "key_id": "123", "expires_at": <unix seconds>}
 *   404/410 {"error": {"code": "connection_not_found" | "connection_revoked" | "session_inactive"}}
 *   401 service credential rejected; 429/5xx temporary.
 */
export function createGatewayKeyResolver(options: GatewayKeyResolverOptions): KeyResolver {
  const ttl = options.cacheTtlMs ?? 5 * 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const timeout = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, CachedKey>();
  const inflight = new Map<string, Promise<string>>();

  async function lookup(identity: ConnectionIdentity, cacheKey: string): Promise<string> {
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${options.serviceToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Evo-Client': 'mcp-remote',
        },
        body: JSON.stringify({ subject: identity.subject, session_id: identity.sessionId, client_id: identity.clientId }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new Error('the gateway key endpoint is unreachable');
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = body.error && typeof body.error === 'object' ? body.error as Record<string, unknown> : {};
      const code = typeof error.code === 'string' ? error.code : '';
      if (CONNECTION_GONE.has(code) || response.status === 404 || response.status === 410) {
        cache.delete(cacheKey);
        throw new KeyUnavailableError(RECONNECT);
      }
      if (response.status === 401 || response.status === 403) throw new Error('the gateway refused this MCP service credential');
      throw new Error(`the gateway key endpoint returned HTTP ${response.status}`);
    }
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new Error('the gateway key endpoint returned no usable key');
    const expiresAt = typeof body.expires_at === 'number' && body.expires_at > 0 ? body.expires_at * 1000 : Infinity;
    const until = Math.min(now() + ttl, expiresAt);
    if (until > now()) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
      cache.set(cacheKey, { key, until });
    }
    return key;
  }

  return {
    async resolve(identity: ConnectionIdentity): Promise<string> {
      if (!identity.sessionId) throw new KeyUnavailableError(RECONNECT);
      const cacheKey = `${identity.subject}\u0000${identity.sessionId}`;
      const hit = cache.get(cacheKey);
      if (hit && hit.until > now()) return hit.key;
      if (hit) cache.delete(cacheKey);
      let pending = inflight.get(cacheKey);
      if (!pending) {
        pending = lookup(identity, cacheKey).finally(() => inflight.delete(cacheKey));
        inflight.set(cacheKey, pending);
      }
      return pending;
    },
  };
}

/** HTTPS anywhere; plain HTTP only inside a private network (loopback, RFC 1918, single-label or .internal names). */
export function checkKeyEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('EVOLINK_MCP_KEY_ENDPOINT is not a valid URL');
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error('EVOLINK_MCP_KEY_ENDPOINT must not contain credentials or a fragment');
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol !== 'http:') throw new Error('EVOLINK_MCP_KEY_ENDPOINT must use HTTPS or HTTP inside a private network');
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateV4 = isIP(host) === 4 && (/^10\./.test(host) || /^127\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host));
  const privateName = !host.includes('.') || host.endsWith('.internal') || host.endsWith('.local') || host === 'localhost';
  if (privateV4 || host === '::1' || privateName) return parsed.toString();
  throw new Error('EVOLINK_MCP_KEY_ENDPOINT may use plain HTTP only inside a private network');
}
