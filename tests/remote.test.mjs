import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRemoteService } from '../packages/remote/dist/remote/src/service.js';
import { createPassportVerifier } from '../packages/remote/dist/remote/src/auth.js';
import { loadSettings } from '../packages/remote/dist/remote/src/settings.js';
import { gatewayAuthHeaders, getApiKey } from '../packages/remote/dist/core/src/config.js';
import { runWithRequestCredentials } from '../packages/remote/dist/core/src/request-context.js';
import { setPollIntervalForTests } from '../packages/remote/dist/core/src/tools/task-format.js';

const ISSUER = 'https://passport.test';
const RESOURCE = 'https://mcp.test/mcp';
const METADATA_URL = 'https://mcp.test/.well-known/oauth-protected-resource/mcp';
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const SERVICE_TOKEN = 'evmcp_remote-test-service-token-0123456789abcdef';
const USER_AGENT = 'remote-test-agent/1.0';

/** How the mock gateway answers the service channel for some sessions, as the A entry does. */
const CHANNEL_OUTCOMES = {
  sess_revoked: [401, 'connection_revoked'],
  sess_gone: [401, 'connection_not_found'],
  sess_inactive: [401, 'session_inactive'],
  sess_expired: [401, 'session_expired'],
  sess_flaky: [503, 'agent_session_unavailable'],
  sess_setup: [500, 'mcp_connection_create_failed'],
  sess_banned: [403, 'user_disabled'],
};

const cleanups = [];
let gateway;
let jwks;
const signingKey = newSigningKey('k1');

test.before(async () => {
  setPollIntervalForTests(20);
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
});

test('tokens that were not issued for this server are rejected as invalid_token', async () => {
  const service = await startService();
  const before = gateway.calls.length;
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
  assert.equal(gateway.calls.length, before, 'rejected tokens never reach the gateway');
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

test('signed-in clients list hosted tools and pay through the service channel without ever holding a key', async () => {
  const service = await startService();
  const token = signToken(signingKey, claims());
  const client = await connect(service.url, token);

  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  for (const name of ['generate_image', 'generate_video', 'get_task', 'estimate_cost', 'check_balance', 'search_models']) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(!names.includes('upload_file'), "files-api takes only the user's own key, so signed-in connections do not offer uploads");

  const result = await client.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a red apple', model: IMAGE_MODEL },
  });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.match(result.content[0].text, /Task task_\d+: completed/);

  const generation = gateway.calls.filter(call => call.path === '/v1/images/generations').at(-1);
  assert.equal(generation.authorization, `Bearer ${SERVICE_TOKEN}`);
  assert.equal(generation.session, 'sess_1');
  assert.equal(generation.subject, 'usr_test');
  assert.equal(generation.mcpClient, 'https://claude.ai/oauth/mcp-oauth-client-metadata');
  assert.equal(generation.body.confirm_cost, undefined);
  assert.equal(generation.body.model, IMAGE_MODEL);
  assert.equal(generation.clientName, USER_AGENT, 'the hosted service reports the assistant from its User-Agent');
  const poll = gateway.calls.filter(call => call.path.startsWith('/v1/tasks/')).at(-1);
  assert.equal(poll.authorization, `Bearer ${SERVICE_TOKEN}`, 'task reads use the same channel');
  assert.equal(poll.session, 'sess_1');

  const toolEvent = service.logs.find(event => event.tools?.includes('generate_image'));
  assert.equal(toolEvent.subject, 'usr_test');
  assert.equal(toolEvent.session, 'sess_1');
  assert.equal(toolEvent.status, 200);
  const logged = JSON.stringify(service.logs);
  assert.ok(!logged.includes(token), 'logs must not contain the access token');
  assert.ok(!logged.includes(SERVICE_TOKEN), 'logs must not contain the service credential');
  await client.close();
});

test('without a service credential, paid tools fail clearly and never fall back to process credentials', async () => {
  const service = await startService({ serviceToken: undefined });
  const previous = process.env.EVOLINK_API_KEY;
  process.env.EVOLINK_API_KEY = 'sk-process-wide-must-not-be-used';
  try {
    assert.throws(() => getApiKey(), /No EvoLink credential/);
    const client = await connect(service.url, signToken(signingKey, claims({ sid: 'sess_unconfigured' })));
    const before = gateway.calls.filter(call => call.path === '/v1/images/generations').length;
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'a blue pear', model: IMAGE_MODEL },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not enabled on this server yet/);
    assert.match(result.content[0].text, /Nothing was submitted or charged/);
    assert.equal(gateway.calls.filter(call => call.path === '/v1/images/generations').length, before);
    assert.ok(!gateway.calls.some(call => call.authorization?.includes('sk-process-wide')));
    await client.close();
  } finally {
    if (previous === undefined) delete process.env.EVOLINK_API_KEY;
    else process.env.EVOLINK_API_KEY = previous;
  }
});

test('API key mode forwards each caller key and keeps concurrent requests apart', async () => {
  const service = await startService({ auth: 'api-key', authorizationServer: undefined, verifier: undefined, serviceToken: undefined });
  const metadata = await fetch(`${service.url}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 404, 'API key mode must not advertise OAuth');

  const anonymous = await rpc(service.url);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer realm="EvoLink MCP"');

  const alpha = await connect(service.url, 'sk-user-alpha-0001');
  const bravo = await connect(service.url, 'sk-user-bravo-0002');
  const upload = (await alpha.listTools()).tools.find(tool => tool.name === 'upload_file');
  assert.ok(upload, "API key mode keeps uploads: they use the caller's own key");
  assert.equal(upload.inputSchema.properties.file_path, undefined, 'hosted upload_file must not read server paths');
  assert.ok(upload.inputSchema.properties.base64_data);
  assert.ok(upload.inputSchema.properties.file_url);
  const [slow, fast] = await Promise.all([
    alpha.callTool({ name: 'generate_image', arguments: { prompt: 'alpha wait=200', model: IMAGE_MODEL } }),
    delay(20).then(() => bravo.callTool({ name: 'generate_image', arguments: { prompt: 'bravo wait=0', model: IMAGE_MODEL } })),
  ]);
  assert.notEqual(slow.isError, true, JSON.stringify(slow));
  assert.notEqual(fast.isError, true, JSON.stringify(fast));
  const byPrompt = prompt => gateway.calls.find(call => call.body?.prompt === prompt);
  assert.equal(byPrompt('alpha wait=200').authorization, 'Bearer sk-user-alpha-0001');
  assert.equal(byPrompt('bravo wait=0').authorization, 'Bearer sk-user-bravo-0002');
  assert.equal(byPrompt('alpha wait=200').session, undefined, 'API key calls carry no channel headers');
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

  const serviceChannel = { serviceToken: SERVICE_TOKEN, sessionId: 'sess_scope', subject: 'usr_scope', clientId: 'https://claude.ai/x' };
  const scoped = await runWithRequestCredentials({ serviceChannel, unavailableReason: 'uploads are off here' }, async () => {
    await delay(5);
    let key;
    try {
      key = getApiKey();
    } catch (error) {
      key = error.message;
    }
    return { headers: gatewayAuthHeaders(), key };
  });
  assert.deepEqual(scoped.headers, {
    'Authorization': `Bearer ${SERVICE_TOKEN}`,
    'X-Evo-Mcp-Session': 'sess_scope',
    'X-Evo-Mcp-Subject': 'usr_scope',
    'X-Evo-Mcp-Client': 'https://claude.ai/x',
  });
  assert.equal(scoped.key, 'uploads are off here', 'the service channel never turns into an API key');
  assert.deepEqual(
    runWithRequestCredentials({ serviceChannel: { ...serviceChannel, clientId: undefined } }, () => Object.keys(gatewayAuthHeaders())),
    ['Authorization', 'X-Evo-Mcp-Session', 'X-Evo-Mcp-Subject'],
  );
  assert.deepEqual(runWithRequestCredentials({ apiKey: 'sk-plain' }, () => gatewayAuthHeaders()), { 'Authorization': 'Bearer sk-plain' });
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

test('a token without a usable session is told to reconnect and nothing is sent', async () => {
  const service = await startService();
  const generations = () => gateway.calls.filter(call => call.path === '/v1/images/generations').length;
  const tokens = [
    claims({ sid: undefined }),
    claims({ sid: 'has space' }),
    claims({ sid: 's'.repeat(81) }),
    claims({ sub: 'u'.repeat(81), sid: 'sess_long_subject' }),
  ];
  for (const payload of tokens) {
    const client = await connect(service.url, signToken(signingKey, payload));
    const before = generations();
    const result = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'no usable session' } });
    assert.equal(result.isError, true, JSON.stringify(payload));
    assert.match(result.content[0].text, /reconnect the existing EvoLink connection/);
    assert.match(result.content[0].text, /Nothing was submitted or charged/);
    assert.equal(generations(), before, 'nothing reaches the gateway');
    await client.close();
  }
  assert.ok(service.logs.some(event => event.channel_error === 'connection_identifiers'));
});

test('service channel rejections give the right next step and nothing is charged', async () => {
  const service = await startService();
  const expectations = [
    ['sess_revoked', /connection_ended, connection_revoked, HTTP 401/, /no longer active .*reconnect the existing EvoLink connection/],
    ['sess_gone', /connection_ended, connection_not_found, HTTP 401/, /reconnect the existing EvoLink connection/],
    ['sess_inactive', /connection_ended, session_inactive, HTTP 401/, /reconnect the existing EvoLink connection/],
    ['sess_expired', /connection_ended, session_expired, HTTP 401/, /reconnect the existing EvoLink connection/],
    ['sess_flaky', /session_check_unavailable, agent_session_unavailable, HTTP 503/, /Retry in a minute; do not reconnect/],
    ['sess_setup', /connection_setup_failed, mcp_connection_create_failed, HTTP 500/, /could not set up this connection/],
    ['sess_banned', /account_disabled, user_disabled, HTTP 403/, /contact EvoLink support/],
  ];
  for (const [sid, category, nextStep] of expectations) {
    const client = await connect(service.url, signToken(signingKey, claims({ sid })));
    const result = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: `channel ${sid}` } });
    assert.equal(result.isError, true, sid);
    assert.match(result.content[0].text, category, sid);
    assert.match(result.content[0].text, nextStep, sid);
    assert.match(result.content[0].text, /Nothing was submitted or charged/, sid);
    assert.equal(result.structuredContent.charged, 'no', sid);
    await client.close();
  }

  // A key the user disabled in the console reads as a connection problem, not "check EVOLINK_API_KEY".
  const disabledClient = await connect(service.url, signToken(signingKey, claims({ sid: 'sess_disabled' })));
  const disabled = await disabledClient.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'disabled-key cat' } });
  assert.equal(disabled.isError, true);
  assert.match(disabled.content[0].text, /key_disabled/);
  assert.match(disabled.content[0].text, /Ask the user to reconnect EvoLink in this client/, 'hosted wording, not "check EVOLINK_API_KEY"');
  assert.match(disabled.content[0].text, /Nothing was submitted or charged/);
  await disabledClient.close();

  // A credential the gateway refuses is this server's problem: the user is not sent to reconnect.
  const misconfigured = await startService({ serviceToken: `evmcp_${'w'.repeat(40)}` });
  const client = await connect(misconfigured.url, signToken(signingKey, claims({ sid: 'sess_misconfigured' })));
  const refused = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'wrong service credential' } });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /service_misconfigured, mcp_service_unauthorized/);
  assert.match(refused.content[0].text, /server-side problem.*do not reconnect/);
  assert.ok(!JSON.stringify(misconfigured.logs).includes('evmcp_'), 'the service credential is never logged');
  await client.close();
});

test('the service credential must match the gateway format, may come from a file, and the removed key settings are refused', () => {
  assert.equal(loadSettings({ EVOLINK_MCP_SERVICE_TOKEN: SERVICE_TOKEN }).serviceToken, SERVICE_TOKEN);
  const fromFile = loadSettings({ EVOLINK_MCP_SERVICE_TOKEN_FILE: '/run/secrets/mcp' }, path => (path === '/run/secrets/mcp' ? `${SERVICE_TOKEN}\n` : ''));
  assert.equal(fromFile.serviceToken, SERVICE_TOKEN);
  assert.equal(loadSettings({}).serviceToken, undefined);
  assert.equal(loadSettings({ EVOLINK_MCP_SERVICE_TOKEN: `evmcp_${'a'.repeat(32)}` }).serviceToken.length, 38, 'shortest accepted');
  assert.equal(loadSettings({ EVOLINK_MCP_SERVICE_TOKEN: `evmcp_${'A-_9'.repeat(64)}` }).serviceToken.length, 262, 'longest accepted');

  for (const bad of ['short', `evmcp_${'a'.repeat(31)}`, `evmcp_${'a'.repeat(257)}`, `svc_${'a'.repeat(40)}`, `evmcp_${'a'.repeat(30)}!!`, `EVMCP_${'a'.repeat(40)}`]) {
    assert.throws(() => loadSettings({ EVOLINK_MCP_SERVICE_TOKEN: bad }), /evmcp_/, bad);
  }
  assert.throws(() => loadSettings({ EVOLINK_MCP_SERVICE_TOKEN: SERVICE_TOKEN, EVOLINK_MCP_SERVICE_TOKEN_FILE: '/x' }, () => SERVICE_TOKEN), /not both/);
  assert.throws(() => loadSettings({ EVOLINK_MCP_AUTH: 'api-key', EVOLINK_MCP_SERVICE_TOKEN: SERVICE_TOKEN }), /only used in oauth mode/);
  for (const removed of ['EVOLINK_MCP_KEY_ENDPOINT', 'EVOLINK_MCP_KEY_CACHE_SECONDS']) {
    assert.throws(() => loadSettings({ [removed]: '300', EVOLINK_MCP_SERVICE_TOKEN: SERVICE_TOKEN }), new RegExp(`${removed} was removed`), removed);
  }
});

// --- helpers ---

async function startService(overrides = {}) {
  const logs = [];
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
    serviceToken: SERVICE_TOKEN,
    logger: event => logs.push(event),
    ...overrides,
  }, { host: '127.0.0.1', port: 0 });
  cleanups.push(() => service.close());
  return { ...service, logs };
}

async function connect(serviceUrl, token) {
  const client = new Client({ name: 'evolink-remote-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${serviceUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT } },
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
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    const session = req.headers['x-evo-mcp-session'];
    const subject = req.headers['x-evo-mcp-subject'];
    calls.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      session,
      subject,
      mcpClient: req.headers['x-evo-mcp-client'],
      clientName: req.headers['x-evo-client-name'],
      body,
    });
    // The MCP service channel (key custody A), checked the way the gateway's A entry does.
    if ((req.headers.authorization ?? '').startsWith('Bearer evmcp_')) {
      const reject = (status, code) => send(status, { error: { code, type: 'authentication_error', message: `rejected: ${code}` } });
      if (req.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) return reject(401, 'mcp_service_unauthorized');
      if (!session || !subject) return reject(400, 'mcp_connection_required');
      const outcome = CHANNEL_OUTCOMES[session];
      if (outcome) return reject(outcome[0], outcome[1]);
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      if ((body?.prompt ?? '').includes('disabled-key')) {
        return send(401, { error: { code: 'KEY_DISABLED', type: 'authentication_error', message: 'API key "mcp" is disabled.' } });
      }
      const wait = Number(/wait=(\d+)/.exec(body?.prompt ?? '')?.[1] ?? 0);
      if (wait) await delay(wait);
      return send(200, { id: `task_${calls.length}`, status: 'pending', model: body?.model, type: 'image', progress: 0, task_info: { estimated_time: 5 } }, { 'x-request-id': 'req_gateway' });
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/tasks/')) {
      const id = decodeURIComponent(req.url.slice('/v1/tasks/'.length));
      return send(200, { id, object: 'task', created: 1, model: IMAGE_MODEL, type: 'image', status: 'completed', progress: 100, results: [`https://files.evolink.ai/${id}.png`], usage: { credits_used: 6.1 } });
    }
    return send(404, {});
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
