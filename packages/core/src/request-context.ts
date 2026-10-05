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
  /** Assistant name sent as X-Evo-Client-Name; the hosted service takes it from the HTTP User-Agent. */
  clientName?: string;
}

const storage = new AsyncLocalStorage<RequestCredentials>();
let processCredentialsDisabled = false;
let processClientName: string | undefined;

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

/** stdio: remember the assistant name from the MCP initialize handshake. */
export function setProcessClientName(name: string | undefined): void {
  processClientName = sanitizeClientName(name);
}

/** The request's assistant name inside a hosted scope, otherwise the stdio client's. */
export function currentClientName(): string | undefined {
  const scoped = storage.getStore();
  if (scoped) return sanitizeClientName(scoped.clientName);
  return processClientName;
}

/** Printable ASCII only, at most 64 characters, so it is safe in a header and a log line. */
export function sanitizeClientName(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 64);
  return cleaned || undefined;
}
