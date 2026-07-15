import { execFileSync } from 'node:child_process';

export interface ServerConfig {
  channel: 'official' | 'beta';
  baseUrl: string;
}

const BASE_URLS = {
  official: 'https://api.evolink.ai',
  beta: 'https://beta-api.evolink.ai',
} as const;

export function createConfig(channel: 'official' | 'beta'): ServerConfig {
  return {
    channel,
    baseUrl: BASE_URLS[channel],
  };
}

export function getApiKey(): string {
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
