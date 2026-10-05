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
  /** Caller's own API key (hosted api-key mode); absent for signed-in connections. */
  apiKey?: string;
  /** Signed-in connections (key custody A): the gateway finds the connection's key itself. */
  serviceChannel?: ServiceChannelCredentials;
  /** Agent-readable reason surfaced by tools that need an API key when there is none. */
  unavailableReason?: string;
  /** Assistant name sent as X-Evo-Client-Name; the hosted service takes it from the HTTP User-Agent. */
  clientName?: string;
}

/**
 * Key custody A: this service never holds a user's key. It authenticates to
 * the gateway with its own credential and names the connection; the gateway
 * looks up that connection's key, checks the Passport session and bills it.
 */
export interface ServiceChannelCredentials {
  /** The MCP service credential (evmcp_…), the same for every connection. */
  serviceToken: string;
  /** Passport session ID (sid) of this connection. */
  sessionId: string;
  /** Passport subject (sub), i.e. the EvoLink account. */
  subject: string;
  /** OAuth client of the connection; the gateway names the connection after it. */
  clientId?: string;
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
