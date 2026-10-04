import { createPublicKey, verify, type KeyObject } from 'node:crypto';

/** Who a verified Passport access token represents. */
export interface ConnectionIdentity {
  subject: string;
  sessionId?: string;
  clientId?: string;
  scopes: string[];
  expiresAt: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<ConnectionIdentity>;
}

/** The token is not acceptable for this resource; the client has to reconnect. */
export class TokenRejectedError extends Error {
  constructor(message: string, readonly code: 'invalid_token' | 'insufficient_scope' = 'invalid_token') {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

/** Verification could not run (for example the JWKS endpoint is down); retry, do not reconnect. */
export class VerifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifierUnavailableError';
  }
}

export interface PassportVerifierOptions {
  /** Expected `iss`, e.g. https://passport.evolink.ai */
  issuer: string;
  /** This MCP server's resource URL; tokens must carry it in `aud`. */
  audience: string;
  jwksUrl: string;
  requiredScope: string;
  clockToleranceSeconds?: number;
  /** How long fetched keys are trusted before a refresh. */
  jwksTtlMs?: number;
  /** Minimum gap between JWKS fetches triggered by unknown key ids or failures. */
  jwksRefreshCooldownMs?: number;
  /** Known keys stay usable this long when refreshes keep failing. */
  jwksMaxStaleMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 8192;
const MAX_JWKS_BYTES = 64 * 1024;

/**
 * Verifies Passport access tokens (compact JWS, ES256 only) against the
 * Passport JWKS, then checks issuer, audience (this MCP resource), lifetime
 * and the MCP scope.
 */
export function createPassportVerifier(options: PassportVerifierOptions): TokenVerifier {
  const tolerance = options.clockToleranceSeconds ?? 60;
  const ttl = options.jwksTtlMs ?? 10 * 60_000;
  const cooldown = options.jwksRefreshCooldownMs ?? 30_000;
  const maxStale = options.jwksMaxStaleMs ?? 60 * 60_000;
  const timeout = options.fetchTimeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const audienceBase = options.audience.replace(/\/+$/, '');
  const audiences = new Set([audienceBase, `${audienceBase}/`]);

  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;
  let attemptedAt = 0;
  let inflight: Promise<void> | undefined;

  async function fetchJwks(): Promise<void> {
    attemptedAt = now();
    let response: Response;
    try {
      response = await fetch(options.jwksUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new VerifierUnavailableError('Passport signing keys are unreachable');
    }
    if (!response.ok) throw new VerifierUnavailableError(`Passport signing keys returned HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_JWKS_BYTES) throw new VerifierUnavailableError('Passport signing keys response is too large');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VerifierUnavailableError('Passport signing keys are not valid JSON');
    }
    const list = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list)) throw new VerifierUnavailableError('Passport signing keys have no keys array');
    const next = new Map<string, KeyObject>();
    for (const value of list) {
      const entry = toVerificationKey(value);
      if (entry) next.set(entry.kid, entry.key);
    }
    keys = next;
    fetchedAt = now();
  }

  function refresh(): Promise<void> {
    inflight ??= fetchJwks().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    if (inflight) {
      // Requests arriving during a fetch wait for it instead of hitting the cooldown.
      await inflight.catch(() => undefined);
    }
    const current = now();
    const expired = current - fetchedAt > ttl;
    if ((expired || !keys.has(kid)) && current - attemptedAt >= cooldown) {
      try {
        await refresh();
      } catch (error) {
        if (!keys.has(kid) || now() - fetchedAt > maxStale) throw error;
      }
    }
    if (fetchedAt === 0) throw new VerifierUnavailableError('Passport signing keys are not loaded');
    if (now() - fetchedAt > maxStale) throw new VerifierUnavailableError('Passport signing keys are stale');
    const key = keys.get(kid);
    if (!key) throw new TokenRejectedError('token signing key is unknown');
    return key;
  }

  function checkClaims(payload: Record<string, unknown>): ConnectionIdentity {
    const seconds = Math.floor(now() / 1000);
    if (payload.iss !== options.issuer) throw new TokenRejectedError('token issuer is not trusted');
    const aud = payload.aud;
    const audList = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : [];
    if (!audList.some(value => typeof value === 'string' && audiences.has(value))) {
      throw new TokenRejectedError('token was not issued for this MCP server');
    }
    if (typeof payload.exp !== 'number' || seconds >= payload.exp + tolerance) {
      throw new TokenRejectedError('token has expired');
    }
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || seconds + tolerance < payload.nbf)) {
      throw new TokenRejectedError('token is not valid yet');
    }
    if (payload.iat !== undefined && (typeof payload.iat !== 'number' || payload.iat > seconds + tolerance)) {
      throw new TokenRejectedError('token issue time is in the future');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw new TokenRejectedError('token has no subject');
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (!scopes.includes(options.requiredScope)) {
      throw new TokenRejectedError(`token lacks the ${options.requiredScope} scope`, 'insufficient_scope');
    }
    return {
      subject: payload.sub,
      sessionId: optionalString(payload.sid),
      clientId: optionalString(payload.client_id),
      scopes,
      expiresAt: payload.exp,
    };
  }

  return {
    async verify(token: string): Promise<ConnectionIdentity> {
      if (token.length > MAX_TOKEN_LENGTH) throw new TokenRejectedError('token is too long');
      const parts = token.split('.');
      if (parts.length !== 3 || !parts.every(part => SEGMENT.test(part))) {
        throw new TokenRejectedError('token is not a compact JWT');
      }
      const header = decodeSegment(parts[0]);
      const payload = decodeSegment(parts[1]);
      if (header.alg !== 'ES256') throw new TokenRejectedError('token algorithm must be ES256');
      if (header.crit !== undefined) throw new TokenRejectedError('token uses unsupported critical headers');
      if (typeof header.kid !== 'string' || !header.kid) throw new TokenRejectedError('token has no key id');
      const signature = Buffer.from(parts[2], 'base64url');
      if (signature.length !== 64) throw new TokenRejectedError('token signature is malformed');
      const key = await keyFor(header.kid);
      const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
      if (!verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature)) {
        throw new TokenRejectedError('token signature is invalid');
      }
      return checkClaims(payload);
    },
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new TokenRejectedError('token is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TokenRejectedError('token is not a JSON object');
  return value as Record<string, unknown>;
}

function toVerificationKey(value: unknown): { kid: string; key: KeyObject } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return undefined;
  if (typeof jwk.kid !== 'string' || !jwk.kid) return undefined;
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
  if (jwk.alg !== undefined && jwk.alg !== 'ES256') return undefined;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return undefined;
  try {
    // Only the public coordinates are used, even if a private `d` was published by mistake.
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    return { kid: jwk.kid, key };
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
