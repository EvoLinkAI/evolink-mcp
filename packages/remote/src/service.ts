import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from '../../core/src/config.js';
import { createServer as createMcpServer } from '../../core/src/server.js';
import {
  disableProcessCredentials,
  runWithRequestCredentials,
  type RequestCredentials,
} from '../../core/src/request-context.js';
import {
  TokenRejectedError,
  VerifierUnavailableError,
  type ConnectionIdentity,
  type TokenVerifier,
} from './auth.js';
import { KeyUnavailableError, type KeyResolver } from './key-resolver.js';
import { FixedWindowLimiter } from './rate-limit.js';

export type AuthMode = 'oauth' | 'api-key';

export interface RemoteServiceOptions {
  /** Gateway the tools call (api.evolink.ai or a staging gateway). */
  config: ServerConfig;
  /** `oauth`: Passport sign-in (mcp.evolink.ai). `api-key`: clients send an EvoLink API key. */
  auth: AuthMode;
  /** Public URL clients connect to, e.g. https://mcp.evolink.ai/mcp */
  resourceUrl: string;
  /** Passport base URL advertised in the protected resource metadata (oauth). */
  authorizationServer?: string;
  verifier?: TokenVerifier;
  keyResolver?: KeyResolver;
  /** Scope a token needs for this server (oauth); default `mcp`. */
  requiredScope?: string;
  documentationUrl?: string;
  /** Requests per minute per connection; 0 disables the limit. */
  rateLimitPerMinute?: number;
  maxBodyBytes?: number;
  /** When set, other Host headers are refused. */
  allowedHosts?: string[];
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
}

type Principal =
  | { kind: 'oauth'; identity: ConnectionIdentity }
  | { kind: 'api-key'; apiKey: string };

const SIGN_IN_REQUIRED =
  'EvoLink MCP requires sign-in. Ask the user to connect EvoLink in this client; it will open the EvoLink sign-in page in a browser.';
const RECONNECT_EXISTING =
  'This EvoLink connection is no longer valid. Ask the user to reconnect the existing EvoLink connection in this client instead of adding a new one.';
const SCOPE_MISSING =
  'This EvoLink connection was approved without MCP access. Ask the user to reconnect the existing EvoLink connection and approve access.';
const API_KEY_REQUIRED =
  'Send an EvoLink API key as "Authorization: Bearer <key>". Create one at https://evolink.ai/dashboard/keys.';
const NO_KEY_NEEDED = 'This request does not carry an EvoLink account key.';
const KEY_LOOKUP_FAILED = 'The EvoLink account key for this connection could not be loaded. Retry shortly; nothing was charged.';

const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;

class BodyTooLargeError extends Error {}

/** Builds the request handler for the hosted MCP endpoint, its metadata and health check. */
export function createRemoteHandler(options: RemoteServiceOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  if (options.auth === 'oauth' && (!options.verifier || !options.authorizationServer)) {
    throw new Error('OAuth mode needs a token verifier and an authorization server URL');
  }
  // Hosted requests only ever use their own credential.
  disableProcessCredentials();

  const resource = new URL(options.resourceUrl);
  const mcpPath = resource.pathname;
  const metadataPath = `/.well-known/oauth-protected-resource${mcpPath === '/' ? '' : mcpPath}`;
  const metadataUrl = `${resource.origin}${metadataPath}`;
  const scope = options.requiredScope ?? 'mcp';
  const now = options.now ?? Date.now;
  const limit = options.rateLimitPerMinute ?? 120;
  const limiter = limit > 0 ? new FixedWindowLimiter(limit, 60_000, now) : undefined;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = options.logger ?? writeLogLine;
  const allowedHosts = options.allowedHosts?.map(host => host.toLowerCase());
  const metadata = {
    resource: options.resourceUrl,
    authorization_servers: options.authorizationServer ? [options.authorizationServer] : [],
    scopes_supported: [scope],
    bearer_methods_supported: ['header'],
    resource_name: 'EvoLink MCP',
    resource_documentation: options.documentationUrl ?? 'https://evolink.ai/mcp',
  };

  function unauthorized(res: ServerResponse, invalid: boolean): void {
    if (options.auth === 'oauth') {
      const challenge = invalid
        ? `Bearer error="invalid_token", error_description="The access token is invalid or expired", resource_metadata="${metadataUrl}"`
        : `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`;
      sendJson(res, 401, invalid
        ? { error: 'invalid_token', error_description: RECONNECT_EXISTING }
        : { error: 'unauthorized', error_description: SIGN_IN_REQUIRED }, { 'WWW-Authenticate': challenge });
      return;
    }
    const challenge = invalid ? 'Bearer realm="EvoLink MCP", error="invalid_token"' : 'Bearer realm="EvoLink MCP"';
    sendJson(res, 401, { error: invalid ? 'invalid_token' : 'unauthorized', error_description: API_KEY_REQUIRED }, {
      'WWW-Authenticate': challenge,
    });
  }

  async function authenticate(req: IncomingMessage, res: ServerResponse, event: Record<string, unknown>): Promise<Principal | undefined> {
    const token = bearerToken(req.headers.authorization);
    if (!token) {
      unauthorized(res, false);
      return undefined;
    }
    if (options.auth === 'api-key') {
      if (!/^[\x21-\x7e]{8,512}$/.test(token)) {
        unauthorized(res, true);
        return undefined;
      }
      event.key_hash = shortHash(token);
      return { kind: 'api-key', apiKey: token };
    }
    try {
      const identity = await options.verifier!.verify(token);
      event.subject = identity.subject;
      event.session = identity.sessionId;
      event.client_id = identity.clientId;
      return { kind: 'oauth', identity };
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        event.auth_error = error.message;
        if (error.code === 'insufficient_scope') {
          sendJson(res, 403, { error: 'insufficient_scope', error_description: SCOPE_MISSING }, {
            'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${metadataUrl}"`,
          });
        } else {
          unauthorized(res, true);
        }
        return undefined;
      }
      if (error instanceof VerifierUnavailableError) {
        event.auth_error = error.message;
        sendJson(res, 503, {
          error: 'temporarily_unavailable',
          error_description: 'EvoLink sign-in verification is temporarily unavailable. Retry shortly; do not reconnect.',
        }, { 'Retry-After': '30' });
        return undefined;
      }
      throw error;
    }
  }

  async function credentialsFor(
    principal: Principal,
    needsKey: boolean,
    clientName: string | undefined,
    event: Record<string, unknown>,
  ): Promise<RequestCredentials> {
    if (principal.kind === 'api-key') return { apiKey: principal.apiKey, clientName };
    if (!needsKey) return { unavailableReason: NO_KEY_NEEDED, clientName };
    if (!options.keyResolver) return { unavailableReason: KEY_LOOKUP_FAILED, clientName };
    try {
      return { apiKey: await options.keyResolver.resolve(principal.identity), clientName };
    } catch (error) {
      event.key_error = error instanceof Error ? error.message : 'unknown';
      return { unavailableReason: error instanceof KeyUnavailableError ? error.message : KEY_LOOKUP_FAILED, clientName };
    }
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, event: Record<string, unknown>): Promise<void> {
    const principal = await authenticate(req, res, event);
    if (!principal) return;

    if (limiter) {
      const limitKey = principal.kind === 'oauth'
        ? `oauth:${principal.identity.sessionId ?? principal.identity.subject}`
        : `key:${shortHash(principal.apiKey)}`;
      const decision = limiter.take(limitKey);
      if (!decision.allowed) {
        sendJson(res, 429, {
          error: 'rate_limited',
          error_description: `Too many requests on this EvoLink connection. Retry after ${decision.retryAfterSeconds} seconds.`,
        }, { 'Retry-After': String(decision.retryAfterSeconds) });
        return;
      }
    }

    if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      sendJson(res, 415, { jsonrpc: '2.0', error: { code: -32000, message: 'Content-Type must be application/json' }, id: null });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, maxBodyBytes)).toString('utf8'));
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.once('finish', () => req.destroy());
        sendJson(res, 413, {
          jsonrpc: '2.0',
          error: { code: -32000, message: `Request body exceeds ${maxBodyBytes} bytes; upload large files with file_url` },
          id: null,
        }, { Connection: 'close' });
        return;
      }
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }

    const calls = describeRpc(body);
    event.rpc = calls.methods;
    if (calls.tools.length > 0) event.tools = calls.tools;
    const clientName = req.headers['user-agent']?.slice(0, 200);
    const credentials = await credentialsFor(principal, calls.tools.length > 0, clientName, event);

    // Stateless: a fresh server and transport per request, closed with the response.
    const server = createMcpServer(options.config, { localFileUploads: false, trackClientName: false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await runWithRequestCredentials(credentials, () => transport.handleRequest(req, res, body));
  }

  async function route(req: IncomingMessage, res: ServerResponse, event: Record<string, unknown>): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    event.path = path.slice(0, 120);

    if (path === '/healthz') {
      if (req.method === 'GET' || req.method === 'HEAD') sendJson(res, 200, { status: 'ok' });
      else sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      return;
    }
    if (allowedHosts && !allowedHosts.includes(hostName(req.headers.host))) {
      sendJson(res, 403, { error: 'forbidden', error_description: 'Host not allowed' });
      return;
    }
    if (path === metadataPath || path === '/.well-known/oauth-protected-resource') {
      if (options.auth !== 'oauth') {
        sendJson(res, 404, { error: 'not_found' });
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, metadata, { 'Cache-Control': 'public, max-age=300' });
      } else {
        sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
      }
      return;
    }
    if (path !== mcpPath) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no standalone SSE stream (GET) and no sessions to delete.
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { Allow: 'POST' });
      return;
    }
    await handleMcp(req, res, event);
  }

  return async (req, res) => {
    const started = now();
    const event: Record<string, unknown> = {
      event: 'mcp_http',
      method: req.method,
      auth: options.auth,
      ip: clientAddress(req),
      user_agent: (req.headers['user-agent'] ?? '').slice(0, 200),
    };
    res.once('close', () => {
      log({ ...event, status: res.statusCode, duration_ms: now() - started });
    });
    try {
      await route(req, res, event);
    } catch (error) {
      event.error = error instanceof Error ? error.name : 'unknown';
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error', error_description: 'Internal error' });
      } else {
        res.destroy();
      }
    }
  };
}

export interface RunningService {
  url: string;
  close(): Promise<void>;
}

/** Starts the hosted service on host:port (port 0 picks a free port). */
export async function startRemoteService(
  options: RemoteServiceOptions,
  listen: { host: string; port: number },
): Promise<RunningService> {
  const handler = createRemoteHandler(options);
  const server = createHttpServer((req, res) => {
    void handler(req, res);
  });
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${host}:${address.port}`,
    // Finishes in-flight requests; the caller decides how long to wait before exiting.
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    }),
  };
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer +(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

function describeRpc(body: unknown): { methods: string[]; tools: string[] } {
  const messages = Array.isArray(body) ? body : [body];
  const methods: string[] = [];
  const tools: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const method = (message as { method?: unknown }).method;
    if (typeof method !== 'string') continue;
    methods.push(method.slice(0, 64));
    if (method === 'tools/call') {
      const name = (message as { params?: { name?: unknown } }).params?.name;
      tools.push(typeof name === 'string' ? name.slice(0, 64) : 'unknown');
    }
  }
  return { methods: methods.slice(0, 20), tools: tools.slice(0, 20) };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new BodyTooLargeError());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (error) {
        req.resume();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(new BodyTooLargeError());
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function hostName(host: string | undefined): string {
  return (host ?? '').toLowerCase().replace(/:\d+$/, '');
}

function clientAddress(req: IncomingMessage): string | undefined {
  const cloudflare = req.headers['cf-connecting-ip'];
  if (typeof cloudflare === 'string' && cloudflare) return cloudflare;
  return req.socket.remoteAddress;
}

function writeLogLine(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}
