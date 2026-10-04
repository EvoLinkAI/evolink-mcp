import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request EvoLink credentials for the hosted (remote) MCP service.
 *
 * The stdio packages never enter a scope, so getApiKey() keeps reading
 * EVOLINK_API_KEY or the CLI credential helper there. Inside a scope the
 * request's own credential is the only one used: there is no fallback to
 * process-wide credentials.
 */
export interface RequestCredentials {
  /** Gateway API key for this request; absent when it could not be resolved. */
  apiKey?: string;
  /** Agent-readable reason surfaced by tools when apiKey is absent. */
  unavailableReason?: string;
}

const storage = new AsyncLocalStorage<RequestCredentials>();
let processCredentialsDisabled = false;

export function runWithRequestCredentials<T>(credentials: RequestCredentials, fn: () => T): T {
  return storage.run(credentials, fn);
}

export function currentRequestCredentials(): RequestCredentials | undefined {
  return storage.getStore();
}

/** Hosted mode: never fall back to EVOLINK_API_KEY or the local credential helper. */
export function disableProcessCredentials(): void {
  processCredentialsDisabled = true;
}

export function processCredentialsAllowed(): boolean {
  return !processCredentialsDisabled;
}
