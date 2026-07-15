import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  apiRequest,
  queryTask,
} from '../packages/evolink-media/dist/core/src/services/api-client.js';
import {
  PaidRequestOutcomeUnknownError,
  parseRetryAfter,
} from '../packages/evolink-media/dist/core/src/services/http-policy.js';
import {
  inspectBase64Upload,
  inspectLocalUpload,
  validateRemoteUploadURL,
  validateUploadDestination,
} from '../packages/evolink-media/dist/core/src/services/upload-policy.js';
import { fileBase64Upload } from '../packages/evolink-media/dist/core/src/services/file-client.js';
import {
  getCatalogModels,
  getCatalogPricing,
  resetCatalogCacheForTests,
} from '../packages/evolink-media/dist/core/src/services/catalog-client.js';
import { registerDeleteFile } from '../packages/evolink-media/dist/core/src/tools/delete-file.js';
import { registerGenerateImage } from '../packages/evolink-media/dist/core/src/tools/generate-image.js';
import { registerUploadFile } from '../packages/evolink-media/dist/core/src/tools/upload-file.js';
import {
  PaidRequestOutcomeUnknownError as RouterOutcomeUnknownError,
  chatRequest,
} from '../packages/evolink-router/dist/services/api-client.js';
import { registerCascade } from '../packages/evolink-router/dist/tools/cascade.js';
import { registerDelegate } from '../packages/evolink-router/dist/tools/delegate.js';
import { resetTextCatalogForTests } from '../packages/evolink-router/dist/services/catalog-client.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.EVOLINK_API_KEY;
const originalControlBase = process.env.EVOLINK_CONTROL_BASE;

test.beforeEach(() => {
  process.env.EVOLINK_API_KEY = 'sk-test-only';
  delete process.env.EVOLINK_CONTROL_BASE;
  resetCatalogCacheForTests();
  resetTextCatalogForTests();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EVOLINK_API_KEY;
  else process.env.EVOLINK_API_KEY = originalKey;
  if (originalControlBase === undefined) delete process.env.EVOLINK_CONTROL_BASE;
  else process.env.EVOLINK_CONTROL_BASE = originalControlBase;
});

test('paid media POST sends an idempotency key but never retries HTTP or transport failures', async () => {
  let calls = 0;
  let idempotencyKey = '';
  let runId = '';
  globalThis.fetch = async (_url, init) => {
    calls++;
    const headers = new Headers(init.headers);
    idempotencyKey = headers.get('idempotency-key') ?? '';
    runId = headers.get('x-evo-run-id') ?? '';
    return new Response('{"error":{"message":"busy"}}', {
      status: 503,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_busy' },
    });
  };
  await assert.rejects(
    apiRequest({ channel: 'official', baseUrl: 'https://api.example' }, {
      method: 'POST', path: '/v1/images/generations', body: { prompt: 'test' }, tool: 'generate_image',
    }),
    error => error.status === 503 && error.requestId === 'req_busy',
  );
  assert.equal(calls, 1);
  assert.match(idempotencyKey, /^run_[a-f0-9]{32}$/);
  assert.equal(runId, idempotencyKey);

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('socket closed');
  };
  await assert.rejects(
    apiRequest({ channel: 'official', baseUrl: 'https://api.example' }, {
      method: 'POST', path: '/v1/images/generations', body: { prompt: 'test' }, tool: 'generate_image',
    }),
    PaidRequestOutcomeUnknownError,
  );
  assert.equal(calls, 1);
});

test('read polling honors retry policy while retaining request evidence', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response('{"error":{"message":"rate limited"}}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      });
    }
    return new Response('{"id":"task_1","model":"m","status":"completed","progress":100,"created":1,"object":"task","type":"image"}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req_task' },
    });
  };
  const task = await queryTask({ channel: 'official', baseUrl: 'https://api.example' }, 'task_1');
  assert.equal(calls, 2);
  assert.equal(task.request_id, 'req_task');
  assert.equal(parseRetryAfter('2'), 2_000);
});

test('canonical Catalog is primary, versioned, and cached by request shape', async () => {
  process.env.EVOLINK_CONTROL_BASE = 'https://control.example';
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const path = new URL(url).pathname;
    if (path === '/v1/catalog/models') {
      return new Response(JSON.stringify({
        meta: { schema_version: '1', catalog_version: 'cat_42', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'gpt-image-live', display_name: 'Live Image', provider: 'EvoLink', aliases: [], capabilities: ['image'], protocols: ['openai-images'], lifecycle: 'active' }],
      }), { status: 200, headers: { 'content-type': 'application/json', etag: '"cat_42"' } });
    }
    if (path === '/v1/catalog/pricing') {
      return new Response(JSON.stringify({
        meta: { schema_version: '1', catalog_version: 'cat_42', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        prices: [{ sku_id: 'sku_1', model_id: 'gpt-image-live', role: 'request', currency: 'USD', unit: '/request', price: '0.01', effective_at: '2026-07-15T12:00:00Z' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const first = await getCatalogModels('image', 'active');
  const second = await getCatalogModels('image', 'active');
  const pricing = await getCatalogPricing('gpt-image-live');
  assert.equal(first.source, 'live');
  assert.equal(second.source, 'cache');
  assert.equal(first.data.meta.catalog_version, 'cat_42');
  assert.equal(first.data.models[0].model_id, 'gpt-image-live');
  assert.equal(pricing.data.prices[0].price, '0.01');
  assert.equal(calls, 2);
});

test('file write is also single-attempt and carries an idempotency key', async () => {
  let calls = 0;
  let key = '';
  globalThis.fetch = async (_url, init) => {
    calls++;
    key = new Headers(init.headers).get('idempotency-key') ?? '';
    return new Response('{"message":"busy"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(fileBase64Upload('ignored-by-transport-test'), error => error.status === 503);
  assert.equal(calls, 1);
  assert.match(key, /^run_[a-f0-9]{32}$/);
});

test('router paid POST is single-attempt and blocks cascade-style retry on unknown outcome', async () => {
  process.env.EVOLINK_CONTROL_BASE = 'https://control.example';
  let paidCalls = 0;
  globalThis.fetch = async url => {
    if (new URL(url).hostname === 'control.example') {
      return new Response(JSON.stringify({
        meta: { schema_version: '1', catalog_version: 'cat_router', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'claude-haiku-4-5-20251001', display_name: 'Haiku', provider: 'Anthropic', aliases: [], capabilities: ['text'], protocols: ['anthropic-messages'], lifecycle: 'active' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    paidCalls++;
    throw new TypeError('connection reset');
  };
  await assert.rejects(
    chatRequest({ baseUrl: 'https://direct.example' }, {
      model: 'claude-haiku-4-5-20251001', prompt: 'hello', maxTokens: 16,
    }),
    RouterOutcomeUnknownError,
  );
  assert.equal(paidCalls, 1);
});

test('router resolves a new model and protocol from canonical Catalog', async () => {
  process.env.EVOLINK_CONTROL_BASE = 'https://control.example';
  let paidPath = '';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'control.example') {
      return new Response(JSON.stringify({
        meta: { schema_version: '1', catalog_version: 'cat_new', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'new-live-model', display_name: 'New Live', provider: 'Example', aliases: ['new-alias'], capabilities: ['text'], protocols: ['openai-chat-completions'], lifecycle: 'active' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    paidPath = parsed.pathname;
    assert.match(new Headers(init.headers).get('idempotency-key') ?? '', /^run_/);
    return new Response(JSON.stringify({
      model: 'new-live-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_new' } });
  };
  const response = await chatRequest({ baseUrl: 'https://direct.example' }, {
    model: 'new-alias', prompt: 'hello', maxTokens: 16,
  });
  assert.equal(paidPath, '/v1/chat/completions');
  assert.equal(response.catalogVersion, 'cat_new');
  assert.equal(response.requestId, 'req_new');
  assert.equal(response.usage.outputTokens, 1);
});

test('local upload policy enforces allowlist, resolved path, size, and MIME signature', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolink-upload-'));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  const png = join(allowed, 'ok.png');
  await writeFile(png, Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('test payload'),
  ]));
  const inspected = await inspectLocalUpload(png, [allowed, outside].join(delimiter));
  assert.equal(inspected.mimeType, 'image/png');
  assert.match(inspected.realPath, /\/allowed\/ok\.png$/);

  const disguised = join(allowed, 'fake.png');
  await writeFile(disguised, 'not a png');
  await assert.rejects(inspectLocalUpload(disguised, allowed), /does not match/);

  const secret = join(outside, 'secret.png');
  await writeFile(secret, Buffer.from('89504e470d0a1a0a', 'hex'));
  const link = join(allowed, 'link.png');
  await symlink(secret, link);
  await assert.rejects(inspectLocalUpload(link, allowed), /outside/);
  await assert.rejects(inspectLocalUpload(png, ''), /disabled/);
});

test('base64, remote URL, and destination policies reject spoofing and traversal', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('payload')]);
  const encoded = png.toString('base64');
  assert.equal(inspectBase64Upload(`data:image/png;base64,${encoded}`).mimeType, 'image/png');
  assert.throws(() => inspectBase64Upload(encoded, 'image/jpeg'), /does not match/);
  assert.throws(() => inspectBase64Upload(encoded), /mime_type is required/);
  assert.throws(() => validateRemoteUploadURL('http://example.com/a.png'), /HTTPS/);
  assert.throws(() => validateRemoteUploadURL('https://127.0.0.1/a.png'), /private/);
  assert.equal(validateRemoteUploadURL('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  assert.throws(() => validateUploadDestination('../private', 'ok.png'), /parent traversal/);
  assert.throws(() => validateUploadDestination('safe', '../bad.png'), /plain file name/);
});

test('MCP paid and destructive tools expose mandatory confirmations and annotations', () => {
  const registrations = [];
  const server = { tool: (...args) => registrations.push(args) };
  registerGenerateImage(server, { channel: 'official', baseUrl: 'https://api.example' });
  registerUploadFile(server);
  registerDeleteFile(server);
  registerDelegate(server, { baseUrl: 'https://direct.example' });
  registerCascade(server, { baseUrl: 'https://direct.example' });

  const byName = name => registrations.find(args => args[0] === name);
  const generation = byName('generate_image');
  assert.equal(generation[2].confirm_cost.safeParse(false).success, false);
  assert.equal(generation[3].idempotentHint, false);
  const upload = byName('upload_file');
  assert.equal(upload[2].confirm_upload.safeParse(false).success, false);
  const deletion = byName('delete_file');
  assert.equal(deletion[2].confirm_delete.safeParse(false).success, false);
  assert.equal(deletion[3].destructiveHint, true);
  const delegate = byName('delegate');
  assert.equal(delegate[2].confirm_paid_request.safeParse(false).success, false);
  const cascade = byName('cascade');
  assert.equal(cascade[2].max_steps.parse(undefined), 1);
  assert.equal(cascade[2].confirm_paid_requests.safeParse(false).success, false);
});

test('real stdio MCP handshake exposes dynamic Catalog tools', async () => {
  const control = createHTTPServer((request, response) => {
    if (request.url?.startsWith('/v1/catalog/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        meta: { schema_version: '1', catalog_version: 'cat_stdio', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'stdio-image', display_name: 'Stdio Image', provider: 'EvoLink', aliases: [], capabilities: ['image'], protocols: ['openai-images'], lifecycle: 'active' }],
      }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', resolve);
  });
  const address = control.address();
  const controlBase = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/evolink-media/dist/evolink-media/src/index.js'],
    cwd: process.cwd(),
    env: {
      EVOLINK_API_KEY: 'sk-stdio-test',
      EVOLINK_CONTROL_BASE: controlBase,
      EVOLINK_MCP_READ_TIMEOUT_MS: '5000',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'evolink-safety-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'model_health'));
    assert.ok(tools.tools.some(tool => tool.name === 'mcp_setup'));
    const result = await client.callTool({ name: 'list_models', arguments: { category: 'image' } });
    const text = result.content.find(item => item.type === 'text')?.text ?? '';
    assert.match(text, /stdio-image/);
    assert.match(text, /cat_stdio/);
  } finally {
    await client.close();
    await new Promise(resolve => control.close(resolve));
  }
});
