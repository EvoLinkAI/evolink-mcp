import { execFileSync } from 'node:child_process';
import { currentRequestCredentials, processCredentialsAllowed } from './request-context.js';

export interface ServerConfig {
  channel: 'official' | 'beta';
  baseUrl: string;
}

const BASE_URLS = {
  official: 'https://api.evolink.ai',
  beta: 'https://beta-api.evolink.ai',
} as const;


/**
 * EVOLINK_BASE_URL overrides the channel default so the same build can point
 * at canary/staging gateways (e.g. https://t-api.evolink.ai) without patching
 * dist. HTTPS is required except for loopback development hosts.
 */
function resolveBaseUrl(channel: 'official' | 'beta'): string {
  const override = (process.env.EVOLINK_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!override) return BASE_URLS[channel];
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(`EVOLINK_BASE_URL is not a valid URL: ${override}`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('EVOLINK_BASE_URL must use HTTPS (or HTTP on localhost).');
  }
  return override;
}

export function createConfig(channel: 'official' | 'beta'): ServerConfig {
  return {
    channel,
    baseUrl: resolveBaseUrl(channel),
  };
}

/**
 * Authentication headers for one gateway call. Signed-in hosted connections go
 * through the MCP service channel (key custody A); everything else sends the
 * caller's API key.
 */
export function gatewayAuthHeaders(): Record<string, string> {
  const channel = currentRequestCredentials()?.serviceChannel;
  if (!channel) return { 'Authorization': `Bearer ${getApiKey()}` };
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${channel.serviceToken}`,
    'X-Evo-Mcp-Session': channel.sessionId,
    'X-Evo-Mcp-Subject': channel.subject,
  };
  if (channel.clientId) headers['X-Evo-Mcp-Client'] = channel.clientId;
  return headers;
}

export function getApiKey(): string {
  const scoped = currentRequestCredentials();
  if (scoped) {
    if (scoped.apiKey) return scoped.apiKey;
    throw new Error(scoped.unavailableReason ?? 'No EvoLink credential is available for this request.');
  }
  if (!processCredentialsAllowed()) {
    throw new Error('No EvoLink credential is available for this request.');
  }

  const configured = process.env.EVOLINK_API_KEY?.trim();
  if (configured) return configured;

  const helper = process.env.EVOLINK_CREDENTIAL_HELPER?.trim() || 'evolink';
  if (helper.includes('\0')) throw new Error('EVOLINK_CREDENTIAL_HELPER is invalid');
  try {
    const key = execFileSync(helper, ['credential', 'get'], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (key) return key;
  } catch {
    // Return one stable recovery message without echoing helper stderr or key material.
  }
  throw new Error(
    'No EvoLink Agent Key is available. Run `evolink login`, keep the evolink CLI on PATH, ' +
    'or set EVOLINK_CREDENTIAL_HELPER to its absolute path.'
  );
}
