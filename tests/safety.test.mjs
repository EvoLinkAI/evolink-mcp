import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

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
import { registerDeleteFile } from '../packages/evolink-media/dist/core/src/tools/delete-file.js';
import { registerGenerateImage } from '../packages/evolink-media/dist/core/src/tools/generate-image.js';
import { registerUploadFile } from '../packages/evolink-media/dist/core/src/tools/upload-file.js';
import {
  PaidRequestOutcomeUnknownError as RouterOutcomeUnknownError,
  chatRequest,
} from '../packages/evolink-router/dist/services/api-client.js';
import { registerCascade } from '../packages/evolink-router/dist/tools/cascade.js';
import { registerDelegate } from '../packages/evolink-router/dist/tools/delegate.js';

const originalFetch = globalThis.fetch;
const originalKey = process.env.EVOLINK_API_KEY;

test.beforeEach(() => {
  process.env.EVOLINK_API_KEY = 'sk-test-only';
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.EVOLINK_API_KEY;
  else process.env.EVOLINK_API_KEY = originalKey;
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
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('connection reset');
  };
  await assert.rejects(
    chatRequest({ baseUrl: 'https://direct.example' }, {
      model: 'claude-haiku-4-5-20251001', prompt: 'hello', maxTokens: 16,
    }),
    RouterOutcomeUnknownError,
  );
  assert.equal(calls, 1);
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
