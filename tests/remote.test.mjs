import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRemoteService } from '../packages/remote/dist/remote/src/service.js';
import { createPassportVerifier } from '../packages/remote/dist/remote/src/auth.js';
import { unconfiguredKeyResolver } from '../packages/remote/dist/remote/src/key-resolver.js';
import { loadSettings } from '../packages/remote/dist/remote/src/settings.js';
import { getApiKey } from '../packages/remote/dist/core/src/config.js';
import { runWithRequestCredentials } from '../packages/remote/dist/core/src/request-context.js';

const ISSUER = 'https://passport.test';
const RESOURCE = 'https://mcp.test/mcp';
const METADATA_URL = 'https://mcp.test/.well-known/oauth-protected-resource/mcp';

const cleanups = [];
let gateway;
let jwks;
const signingKey = newSigningKey('k1');

test.before(async () => {
  gateway = await startGateway();
  jwks = await startJwks([signingKey.jwk]);
  process.env.EVOLINK_CONTROL_BASE = gateway.url;
});

test.after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  await gateway.close();
  await jwks.close();
});

test('health check, protected resource metadata, and method guard', async () => {
  const service = await startService();
  const health = await fetch(`${service.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await fetch(`${service.url}${path}`);
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.equal(metadata.resource, RESOURCE);
    assert.deepEqual(metadata.authorization_servers, [ISSUER]);
    assert.deepEqual(metadata.scopes_supported, ['mcp']);
    assert.deepEqual(metadata.bearer_methods_supported, ['header']);
  }

  const get = await fetch(`${service.url}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
});

test('unauthenticated MCP requests get a 401 that points clients to Passport', async () => {
  const service = await startService();
  const before = gateway.calls.length;
  const response = await rpc(service.url);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${METADATA_URL}", scope="mcp"`);
  assert.equal(response.body.error, 'unauthorized');
  assert.match(response.body.error_description, /requires sign-in/);
  assert.equal(gateway.calls.length, before);
  assert.equal(service.resolved.length, 0);
});

test('tokens that were not issued for this server are rejected as invalid_token', async () => {
  const service = await startService();
  const now = Math.floor(Date.now() / 1000);
  const strangerKey = newSigningKey('k1');
  const valid = signToken(signingKey, claims());
  const [validHeader, , validSignature] = valid.split('.');
  const cases = {
    'wrong audience': signToken(signingKey, claims({ aud: 'https://api.evolink.ai' })),
    'wrong issuer': signToken(signingKey, claims({ iss: 'https://evil.test' })),
    expired: signToken(signingKey, claims({ exp: now - 3600, iat: now - 7200, nbf: now - 7200 })),
    'not yet valid': signToken(signingKey, claims({ nbf: now + 3600 })),
    'tampered payload': `${validHeader}.${b64(claims({ sub: 'usr_other' }))}.${validSignature}`,
    'algorithm downgrade': signToken(signingKey, claims(), { alg: 'HS256' }),
    'alg none': `${b64({ alg: 'none', kid: 'k1' })}.${b64(claims())}.`,
    'unknown key id': signToken(newSigningKey('k-unknown'), claims()),
    'same key id, different key': signToken(strangerKey, claims()),
    'not a JWT': 'not-a-jwt',
  };
  for (const [name, token] of Object.entries(cases)) {
    const response = await rpc(service.url, { token });
    assert.equal(response.status, 401, name);
    const challenge = response.headers.get('www-authenticate');
    assert.match(challenge, /error="invalid_token"/, name);
    assert.ok(challenge.includes(`resource_metadata="${METADATA_URL}"`), name);
    assert.equal(response.body.error, 'invalid_token', name);
    assert.match(response.body.error_description, /reconnect the existing EvoLink connection/, name);
  }
  assert.equal(service.resolved.length, 0);
});

test('a token without the mcp scope gets 403 insufficient_scope', async () => {
  const service = await startService();
  const response = await rpc(service.url, { token: signToken(signingKey, claims({ scope: 'offline_access' })) });
  assert.equal(response.status, 403);
  const challenge = response.headers.get('www-authenticate');
  assert.match(challenge, /error="insufficient_scope"/);
  assert.match(challenge, /scope="mcp"/);
  assert.equal(response.body.error, 'insufficient_scope');
});

test('signed-in clients list hosted tools and pay with their own connection key', async () => {
  const service = await startService();
  const token = signToken(signingKey, claims());
  const client = await connect(service.url, token);

  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of ['generate_image', 'generate_video', 'check_task', 'upload_file', 'estimate_cost']) {
    assert.ok(names.includes(name), name);
  }
  const upload = tools.find(tool => tool.name === 'upload_file');
  assert.equal(upload.inputSchema.properties.file_path, undefined, 'hosted upload_file must not read server paths');
  assert.ok(upload.inputSchema.properties.base64_data);
  assert.ok(upload.inputSchema.properties.file_url);
  assert.equal(service.resolved.length, 0, 'no key lookup before a tool call');

  const result = await client.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a red apple', model: 'gpt-image-1', confirm_cost: true },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /Task ID: task_/);

  const generation = gateway.calls.filter(call => call.path === '/v1/images/generations').at(-1);
  assert.equal(generation.authorization, 'Bearer sk-conn-sess_1');
  assert.equal(generation.body.confirm_cost, undefined);
  assert.deepEqual(service.resolved.at(-1), {
    subject: 'usr_test',
    sessionId: 'sess_1',
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    scopes: ['mcp', 'offline_access'],
    expiresAt: claims().exp,
  });

  const toolEvent = service.logs.find(event => event.tools?.includes('generate_image'));
  assert.equal(toolEvent.subject, 'usr_test');
  assert.equal(toolEvent.session, 'sess_1');
  assert.equal(toolEvent.status, 200);
  const logged = JSON.stringify(service.logs);
  assert.ok(!logged.includes(token), 'logs must not contain the access token');
  assert.ok(!logged.includes('sk-conn-sess_1'), 'logs must not contain the gateway key');
  await client.close();
});

test('without a key service, paid tools fail clearly and never fall back to process credentials', async () => {
  const service = await startService({ keyResolver: unconfiguredKeyResolver });
  const previous = process.env.EVOLINK_API_KEY;
  process.env.EVOLINK_API_KEY = 'sk-process-wide-must-not-be-used';
  try {
    assert.throws(() => getApiKey(), /No EvoLink credential/);
    const client = await connect(service.url, signToken(signingKey, claims({ sid: 'sess_unconfigured' })));
    const before = gateway.calls.filter(call => call.path === '/v1/images/generations').length;
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'a blue pear', model: 'gpt-image-1', confirm_cost: true },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not enabled on this server yet/);
    assert.equal(gateway.calls.filter(call => call.path === '/v1/images/generations').length, before);
    assert.ok(!gateway.calls.some(call => call.authorization?.includes('sk-process-wide')));
    await client.close();
  } finally {
    if (previous === undefined) delete process.env.EVOLINK_API_KEY;
    else process.env.EVOLINK_API_KEY = previous;
  }
});

test('API key mode forwards each caller key and keeps concurrent requests apart', async () => {
  const service = await startService({ auth: 'api-key', authorizationServer: undefined, verifier: undefined, keyResolver: undefined });
  const metadata = await fetch(`${service.url}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 404, 'API key mode must not advertise OAuth');

  const anonymous = await rpc(service.url);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="EvoLink MCP"');

  const alpha = await connect(service.url, 'sk-user-alpha-0001');
  const bravo = await connect(service.url, 'sk-user-bravo-0002');
  const [slow, fast] = await Promise.all([
    alpha.callTool({ name: 'generate_image', arguments: { prompt: 'alpha wait=200', model: 'gpt-image-1', confirm_cost: true } }),
    delay(20).then(() => bravo.callTool({ name: 'generate_image', arguments: { prompt: 'bravo wait=0', model: 'gpt-image-1', confirm_cost: true } })),
  ]);
  assert.notEqual(slow.isError, true, JSON.stringify(slow));
  assert.notEqual(fast.isError, true, JSON.stringify(fast));
  const byPrompt = prompt => gateway.calls.find(call => call.body?.prompt === prompt);
  assert.equal(byPrompt('alpha wait=200').authorization, 'Bearer sk-user-alpha-0001');
  assert.equal(byPrompt('bravo wait=0').authorization, 'Bearer sk-user-bravo-0002');
  assert.ok(!JSON.stringify(service.logs).includes('sk-user-alpha-0001'));
  await alpha.close();
  await bravo.close();
});

test('requests over the per-connection limit get 429 with Retry-After', async () => {
  const service = await startService({ rateLimitPerMinute: 2 });
  const token = signToken(signingKey, claims({ sid: 'sess_limited' }));
  const statuses = [];
  let last;
  for (let i = 0; i < 3; i++) {
    last = await rpc(service.url, { token });
    statuses.push(last.status);
  }
  assert.deepEqual(statuses, [200, 200, 429]);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
  const other = await rpc(service.url, { token: signToken(signingKey, claims({ sid: 'sess_other' })) });
  assert.equal(other.status, 200, 'limits are per connection');
});

test('oversized, malformed, and non-JSON bodies are refused before reaching tools', async () => {
  const service = await startService({ maxBodyBytes: 2048 });
  const token = signToken(signingKey, claims({ sid: 'sess_body' }));
  const large = await rpc(service.url, { token, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4096) } }) });
  assert.equal(large.status, 413);
  const malformed = await rpc(service.url, { token, body: '{"jsonrpc":' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, -32700);
  const text = await rpc(service.url, { token, headers: { 'content-type': 'text/plain' } });
  assert.equal(text.status, 415);
});

test('the Host allowlist refuses other hosts', async () => {
  const service = await startService({ allowedHosts: ['mcp.test'] });
  assert.equal((await rawPost(service.url, 'evil.test')).status, 403);
  assert.equal((await rawPost(service.url, 'mcp.test')).status, 401);
});

test('a newly published signing key is picked up, and a JWKS outage returns 503 instead of 401', async () => {
  const service = await startService();
  const rotated = newSigningKey('k2');
  const before = jwks.fetches;
  const rejected = await rpc(service.url, { token: signToken(rotated, claims({ sid: 'sess_rotation' })) });
  assert.equal(rejected.status, 401, 'unpublished key');
  jwks.keys.push(rotated.jwk);
  const accepted = await rpc(service.url, { token: signToken(rotated, claims({ sid: 'sess_rotation' })) });
  assert.equal(accepted.status, 200);
  assert.ok(jwks.fetches > before);

  const offline = await startService({
    verifier: createPassportVerifier({ issuer: ISSUER, audience: RESOURCE, jwksUrl: 'http://127.0.0.1:9/jwks.json', requiredScope: 'mcp', fetchTimeoutMs: 1000 }),
  });
  const unavailable = await rpc(offline.url, { token: signToken(signingKey, claims()) });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '30');
  assert.equal(unavailable.headers.get('www-authenticate'), null);
});

test('request credentials stay with their own request across interleaved awaits', async () => {
  const results = await Promise.all([
    runWithRequestCredentials({ apiKey: 'sk-first-request' }, async () => {
      await delay(30);
      return getApiKey();
    }),
    runWithRequestCredentials({ apiKey: 'sk-second-request' }, async () => {
      await delay(5);
      return getApiKey();
    }),
    runWithRequestCredentials({ unavailableReason: 'no key for this one' }, async () => {
      await delay(15);
      return getApiKey();
    }).catch(error => error.message),
  ]);
  assert.deepEqual(results, ['sk-first-request', 'sk-second-request', 'no key for this one']);
});

test('hosted settings refuse process-wide credentials and insecure URLs', () => {
  assert.throws(() => loadSettings({ EVOLINK_API_KEY: 'sk-x' }), /EVOLINK_API_KEY must not be set/);
  assert.throws(() => loadSettings({ EVOLINK_CREDENTIAL_HELPER: '/usr/local/bin/evolink' }), /EVOLINK_CREDENTIAL_HELPER/);
  assert.throws(() => loadSettings({ EVOLINK_UPLOAD_ALLOWED_DIRS: '/srv' }), /EVOLINK_UPLOAD_ALLOWED_DIRS/);
  assert.throws(() => loadSettings({ EVOLINK_MCP_AUTH: 'none' }), /EVOLINK_MCP_AUTH/);
  assert.throws(() => loadSettings({ EVOLINK_MCP_RESOURCE_URL: 'http://mcp.evolink.ai/mcp' }), /HTTPS/);
  assert.throws(() => loadSettings({ EVOLINK_MCP_RESOURCE_URL: 'https://mcp.evolink.ai/mcp?x=1' }), /query/);
  assert.throws(() => loadSettings({ EVOLINK_MCP_REQUIRED_SCOPE: 'mcp"x' }), /scope/);

  const defaults = loadSettings({});
  assert.equal(defaults.auth, 'oauth');
  assert.equal(defaults.resourceUrl, 'https://mcp.evolink.ai/mcp');
  assert.equal(defaults.authorizationServer, 'https://passport.evolink.ai');
  assert.equal(defaults.issuer, 'https://passport.evolink.ai');
  assert.equal(defaults.jwksUrl, 'https://passport.evolink.ai/.well-known/jwks.json');
  assert.equal(defaults.requiredScope, 'mcp');
  assert.equal(defaults.documentationUrl, 'https://evolink.ai/mcp');
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 8090);
  assert.equal(loadSettings({ EVOLINK_MCP_RESOURCE_URL: 'https://mcp.evolink.ai/mcp/' }).resourceUrl, 'https://mcp.evolink.ai/mcp');
  assert.deepEqual(loadSettings({ EVOLINK_MCP_ALLOWED_HOSTS: 'mcp.evolink.ai, MCP-key.evolink.ai' }).allowedHosts, ['mcp.evolink.ai', 'mcp-key.evolink.ai']);
});

// --- helpers ---

async function startService(overrides = {}) {
  const logs = [];
  const resolved = [];
  const service = await startRemoteService({
    config: { channel: 'official', baseUrl: gateway.url },
    auth: 'oauth',
    resourceUrl: RESOURCE,
    authorizationServer: ISSUER,
    verifier: createPassportVerifier({
      issuer: ISSUER,
      audience: RESOURCE,
      jwksUrl: `${jwks.url}/jwks.json`,
      requiredScope: 'mcp',
      jwksRefreshCooldownMs: 0,
    }),
    keyResolver: {
      async resolve(identity) {
        resolved.push(identity);
        return `sk-conn-${identity.sessionId}`;
      },
    },
    logger: event => logs.push(event),
    ...overrides,
  }, { host: '127.0.0.1', port: 0 });
  cleanups.push(() => service.close());
  return { ...service, logs, resolved };
}

async function connect(serviceUrl, token) {
  const client = new Client({ name: 'evolink-remote-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${serviceUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function rpc(serviceUrl, { token, body, headers = {} } = {}) {
  const payload = body ?? JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
  });
  const response = await fetch(`${serviceUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: payload,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function rawPost(serviceUrl, host) {
  const { hostname, port } = new URL(serviceUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: '/mcp', method: 'POST', headers: { host, 'content-type': 'application/json' } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function startGateway() {
  const calls = [];
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.url.startsWith('/v1/catalog/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        meta: { catalog_version: 'cat-test', schema_version: '1' },
        models: [{
          model_id: 'gpt-image-1', display_name: 'GPT Image 1', provider: 'EvoLink', aliases: [],
          capabilities: ['image'], protocols: ['openai-images'], lifecycle: 'active',
        }],
      }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      const wait = Number(/wait=(\d+)/.exec(body?.prompt ?? '')?.[1] ?? 0);
      if (wait) await delay(wait);
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_gateway' });
      res.end(JSON.stringify({ id: `task_${calls.length}`, status: 'pending', task_info: { estimated_time: 5 } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return { ...server, calls };
}

async function startJwks(initialKeys) {
  const state = { keys: [...initialKeys], fetches: 0 };
  const server = await listen((req, res) => {
    state.fetches += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: state.keys }));
  });
  return Object.assign(state, server);
}

function newSigningKey(kid) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signToken(key, payload, header = {}) {
  const input = `${b64({ alg: 'ES256', typ: 'JWT', kid: key.kid, ...header })}.${b64(payload)}`;
  const signature = signBytes('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

const NOW = Math.floor(Date.now() / 1000);

function claims(overrides = {}) {
  return {
    iss: ISSUER,
    sub: 'usr_test',
    aud: RESOURCE,
    exp: NOW + 600,
    iat: NOW,
    nbf: NOW,
    scope: 'mcp offline_access',
    sid: 'sess_1',
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    ...overrides,
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
