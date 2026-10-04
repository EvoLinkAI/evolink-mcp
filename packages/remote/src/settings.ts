import type { AuthMode } from './service.js';

export interface RemoteSettings {
  host: string;
  port: number;
  auth: AuthMode;
  resourceUrl: string;
  authorizationServer: string;
  issuer: string;
  jwksUrl: string;
  requiredScope: string;
  documentationUrl: string;
  rateLimitPerMinute: number;
  maxBodyBytes: number;
  allowedHosts?: string[];
}

/** Process-wide credentials would bill every connection to one account, and a local upload allowlist would expose this server's disk. */
const FORBIDDEN = ['EVOLINK_API_KEY', 'EVOLINK_CREDENTIAL_HELPER', 'EVOLINK_UPLOAD_ALLOWED_DIRS'];

export function loadSettings(env: NodeJS.ProcessEnv): RemoteSettings {
  for (const name of FORBIDDEN) {
    if (env[name]?.trim()) {
      throw new Error(`${name} must not be set for the hosted MCP service: every request uses its own credential.`);
    }
  }

  const auth = (env.EVOLINK_MCP_AUTH ?? 'oauth').trim();
  if (auth !== 'oauth' && auth !== 'api-key') throw new Error('EVOLINK_MCP_AUTH must be "oauth" or "api-key"');

  const resourceUrl = canonicalUrl(env.EVOLINK_MCP_RESOURCE_URL ?? 'https://mcp.evolink.ai/mcp', 'EVOLINK_MCP_RESOURCE_URL');
  const authorizationServer = canonicalUrl(
    env.EVOLINK_MCP_AUTHORIZATION_SERVER ?? 'https://passport.evolink.ai',
    'EVOLINK_MCP_AUTHORIZATION_SERVER',
  );
  const issuer = (env.EVOLINK_MCP_TOKEN_ISSUER ?? authorizationServer).trim();
  const jwksUrl = canonicalUrl(env.EVOLINK_MCP_JWKS_URL ?? `${authorizationServer}/.well-known/jwks.json`, 'EVOLINK_MCP_JWKS_URL');

  const requiredScope = (env.EVOLINK_MCP_REQUIRED_SCOPE ?? 'mcp').trim();
  // The scope is echoed inside WWW-Authenticate, so keep it to RFC 6749 scope-token characters.
  if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(requiredScope)) throw new Error('EVOLINK_MCP_REQUIRED_SCOPE is not a valid scope');

  const allowedHosts = (env.EVOLINK_MCP_ALLOWED_HOSTS ?? '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);

  return {
    host: (env.EVOLINK_MCP_HOST ?? '127.0.0.1').trim(),
    port: integer(env.EVOLINK_MCP_PORT, 8090, 0, 65_535, 'EVOLINK_MCP_PORT'),
    auth,
    resourceUrl,
    authorizationServer,
    issuer,
    jwksUrl,
    requiredScope,
    documentationUrl: (env.EVOLINK_MCP_DOCUMENTATION_URL ?? 'https://evolink.ai/mcp').trim(),
    rateLimitPerMinute: integer(env.EVOLINK_MCP_RATE_LIMIT_PER_MINUTE, 120, 0, 100_000, 'EVOLINK_MCP_RATE_LIMIT_PER_MINUTE'),
    maxBodyBytes: integer(env.EVOLINK_MCP_MAX_BODY_BYTES, 100 * 1024 * 1024, 1024, 512 * 1024 * 1024, 'EVOLINK_MCP_MAX_BODY_BYTES'),
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
  };
}

/** HTTPS (HTTP only on loopback), no credentials, query or fragment; no trailing slash except the root. */
function canonicalUrl(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only on loopback)`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, a query or a fragment`);
  }
  return parsed.pathname === '/' ? parsed.origin : `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}
