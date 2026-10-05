import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHTTPServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { apiRequest, queryTask, submitTask } from '../packages/evolink-media/dist/core/src/services/api-client.js';
import { PaidRequestOutcomeUnknownError, parseRetryAfter } from '../packages/evolink-media/dist/core/src/services/http-policy.js';
import {
  inspectBase64Upload,
  inspectLocalUpload,
  validateRemoteUploadURL,
  validateUploadDestination,
} from '../packages/evolink-media/dist/core/src/services/upload-policy.js';
import { fileBase64Upload } from '../packages/evolink-media/dist/core/src/services/file-client.js';
import { classifyGatewayError } from '../packages/evolink-media/dist/core/src/services/error-handler.js';
import { closestMatches, validateInput } from '../packages/evolink-media/dist/core/src/services/param-validator.js';
import { estimateCost, resetPricingCacheForTests, skuPrice } from '../packages/evolink-media/dist/core/src/services/pricing-client.js';
import { allModelParams, findModelParams } from '../packages/evolink-media/dist/core/src/data/model-params.js';
import { createServer } from '../packages/evolink-media/dist/core/src/server.js';
import { setPollIntervalForTests } from '../packages/evolink-media/dist/core/src/tools/task-format.js';
import { parseSince } from '../packages/evolink-media/dist/core/src/tools/list-tasks.js';
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
const CONFIG = { channel: 'official', baseUrl: 'https://api.example' };

const TOOL_NAMES = [
  'check_balance', 'estimate_cost', 'generate_audio', 'generate_image', 'generate_video',
  'get_model', 'get_task', 'list_tasks', 'search_models', 'upload_file',
];
const PAID_TOOLS = ['generate_image', 'generate_video', 'generate_audio'];

// Real documented models, so the tests follow the bundled parameter index.
const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';
const VIDEO_MODEL = 'seedance-2.0-text-to-video';
const imageSpec = findModelParams(IMAGE_MODEL);
const videoSpec = findModelParams(VIDEO_MODEL);

const PRICING = [
  { sku_id: '1', sku_name: 'Nano Banana 2', model_name: IMAGE_MODEL, model_type: 'image', billing_rule: 'per_image', routing_note: 'Transparent Pricing: $0.086-$0.094 per image. Calls prioritize…' },
  { sku_id: '2', sku_name: 'Nano Banana 2 - 4K Output', model_name: IMAGE_MODEL, model_type: 'image', billing_rule: 'per_image', routing_note: 'Transparent Pricing: $0.129-$0.141 per image.' },
  { sku_id: '3', sku_name: 'Nano Banana 2 - Input Image', model_name: IMAGE_MODEL, model_type: 'image', billing_rule: 'per_image', routing_note: 'Transparent Pricing: $0.0005 per image.' },
  { sku_id: '4', sku_name: 'Seedance 2.0 Text to Video', model_name: VIDEO_MODEL, model_type: 'video', billing_rule: 'per_second', routing_note: 'Transparent Pricing: $0.199-$0.219 per second.' },
  { sku_id: '5', sku_name: 'gpt-image-2 Image Output', model_name: 'gpt-image-2', model_type: 'image', billing_rule: 'per_1k_tokens', routing_note: 'Transparent Pricing: $27 per 1M tokens.' },
  { sku_id: '6', sku_name: 'Priced Only Video', model_name: 'priced-only-video', model_type: 'video', billing_rule: 'per_call', price_range: { min_usd: 0.5, max_usd: 0.5 } },
  { sku_id: '7', sku_name: 'Some Chat', model_name: 'some-chat', model_type: 'text', billing_rule: 'per_token', routing_note: 'Transparent Pricing: $1 per 1M tokens.' },
];

test.beforeEach(() => {
  process.env.EVOLINK_API_KEY = 'sk-test-only';
  process.env.EVOLINK_CONTROL_BASE = 'https://control.example';
  resetPricingCacheForTests();
  resetTextCatalogForTests();
  setPollIntervalForTests(20);
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  setPollIntervalForTests(undefined);
  if (originalKey === undefined) delete process.env.EVOLINK_API_KEY;
  else process.env.EVOLINK_API_KEY = originalKey;
  if (originalControlBase === undefined) delete process.env.EVOLINK_CONTROL_BASE;
  else process.env.EVOLINK_CONTROL_BASE = originalControlBase;
});

// --- helpers ---

/** Deterministic PRNG (mulberry32) so generated cases are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Routes keyed "METHOD /path"; "/v1/tasks/:id" matches any single task ID. */
function installGateway(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body;
    if (typeof init.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const call = { method, host: parsed.host, path: parsed.pathname, query: parsed.searchParams, headers, body };
    calls.push(call);
    const handler = routes[`${method} ${parsed.pathname}`]
      ?? routes[`${method} ${parsed.pathname.replace(/^\/v1\/tasks\/[^/]+$/, '/v1/tasks/:id')}`];
    if (!handler) return json(404, { error: { message: `no mock for ${method} ${parsed.pathname}` } });
    return handler(call);
  };
  return calls;
}

function baseRoutes(extra = {}) {
  return {
    'GET /web/api/models/pricing': () => json(200, { success: true, data: PRICING }),
    'GET /v1/credits': () => json(200, {
      success: true,
      data: {
        user: { remaining_credits: 340, used_credits: 12 },
        token: { remaining_credits: 99999.9999, used_credits: 6.8, unlimited_credits: true },
      },
    }),
    ...extra,
  };
}

function task(id, status, extra = {}) {
  return { id, object: 'task', created: 1_790_000_000, model: IMAGE_MODEL, type: 'image', progress: status === 'completed' ? 100 : 40, status, task_info: { can_cancel: false }, ...extra };
}

async function connect(clientName = 'safety-test') {
  const server = createServer(CONFIG);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

function validImageInput() {
  return { prompt: 'a red apple on a table' };
}

function validVideoInput() {
  const input = { ...(videoSpec.example ?? {}), prompt: 'a paper boat on a river' };
  const duration = videoSpec.params.duration;
  if (duration?.enum) input.duration = duration.enum.find(value => typeof value === 'number') ?? duration.enum[0];
  else if (duration) input.duration = duration.minimum ?? 5;
  return input;
}

// --- transport and retry policy ---

test('paid submit retries once with one idempotency key and never creates a second intent', async () => {
  let calls = 0;
  const keys = [];
  const runIds = [];
  globalThis.fetch = async (_url, init) => {
    calls++;
    const headers = new Headers(init.headers);
    keys.push(headers.get('idempotency-key') ?? '');
    runIds.push(headers.get('x-evo-run-id') ?? '');
    return json(503, { error: { message: 'busy', code: 'service_unavailable' } }, { 'x-request-id': 'req_busy' });
  };
  await assert.rejects(
    submitTask(CONFIG, { path: '/v1/images/generations', body: { prompt: 'test' }, tool: 'generate_image' }),
    error => error.status === 503 && error.requestId === 'req_busy' && error.info.category === 'model_unavailable',
  );
  assert.equal(calls, 2);
  assert.match(keys[0], /^run_[a-f0-9]{32}$/);
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.deepEqual(runIds, keys);

  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError('socket closed');
  };
  await assert.rejects(
    apiRequest(CONFIG, { method: 'POST', path: '/v1/images/generations', body: { prompt: 'test' }, tool: 'generate_image' }),
    PaidRequestOutcomeUnknownError,
  );
  assert.equal(calls, 2);
});

test('a key or balance rejection is not retried', async () => {
  for (const code of ['insufficient_quota', 'insufficient_token_quota', 'token_daily_quota_exceeded']) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return json(402, { error: { code, type: 'insufficient_quota', message: 'no' } });
    };
    await assert.rejects(submitTask(CONFIG, { path: '/v1/images/generations', body: {}, tool: 'generate_image' }), error => error.status === 402);
    assert.equal(calls, 1, code);
  }
});

test('reads honor Retry-After and keep the request ID', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return json(429, { error: { message: 'rate limited' } }, { 'retry-after': '0' });
    return json(200, task('task_1', 'completed'), { 'x-request-id': 'req_task' });
  };
  const result = await queryTask(CONFIG, 'task_1');
  assert.equal(calls, 2);
  assert.equal(result.request_id, 'req_task');
  assert.equal(parseRetryAfter('2'), 2_000);
});

test('file upload is single-attempt and carries an idempotency key', async () => {
  let calls = 0;
  let key = '';
  globalThis.fetch = async (_url, init) => {
    calls++;
    key = new Headers(init.headers).get('idempotency-key') ?? '';
    return json(503, { message: 'busy' });
  };
  await assert.rejects(fileBase64Upload('ignored-by-transport-test'), error => error.status === 503);
  assert.equal(calls, 1);
  assert.match(key, /^run_[a-f0-9]{32}$/);
});

// --- error classification ---

test('gateway errors are classified by code first, with absolute console links and figures', () => {
  const cases = [
    [402, 'insufficient_quota', 'account_balance_insufficient', 'https://evolink.ai/dashboard/credits'],
    [402, 'insufficient_user_quota', 'account_balance_insufficient', 'https://evolink.ai/dashboard/credits'],
    [402, 'ACCOUNT_BALANCE_INSUFFICIENT', 'account_balance_insufficient', 'https://evolink.ai/dashboard/credits'],
    [402, 'insufficient_token_quota', 'key_quota_exhausted', 'https://evolink.ai/dashboard/keys'],
    [402, 'KEY_QUOTA_EXHAUSTED', 'key_quota_exhausted', 'https://evolink.ai/dashboard/keys'],
    [402, 'token_daily_quota_exceeded', 'key_daily_quota_exhausted', 'https://evolink.ai/dashboard/keys'],
    [401, 'KEY_DISABLED', 'key_disabled', 'https://evolink.ai/dashboard/keys'],
    [401, 'KEY_EXPIRED', 'key_expired', 'https://evolink.ai/dashboard/keys'],
    [403, 'KEY_MODEL_NOT_ALLOWED', 'model_not_allowed', 'https://evolink.ai/dashboard/keys'],
    [409, 'idempotency_conflict', 'idempotency_conflict', undefined],
    [409, 'paid_outcome_unknown', 'outcome_unknown', undefined],
    [400, 'no_available_channel', 'model_unavailable', undefined],
    [400, 'content_policy_violation', 'content_policy', undefined],
    [400, 'invalid_parameter', 'invalid_request', undefined],
    [402, undefined, 'account_balance_insufficient', 'https://evolink.ai/dashboard/credits'],
    [401, undefined, 'unauthorized', undefined],
    [404, 'task_not_found', 'not_found', undefined],
    [413, undefined, 'request_too_large', undefined],
    [429, 'rate_limit_exceeded', 'rate_limited', undefined],
    [500, 'internal_error', 'server_error', undefined],
    [503, undefined, 'model_unavailable', undefined],
  ];
  for (const [status, code, category, actionUrl] of cases) {
    const info = classifyGatewayError(status, { error: { code, message: `m (request id: req_1)` } }, 5_000, 'req_header');
    assert.equal(info.category, category, `${status} ${code}`);
    assert.equal(info.action_url, actionUrl, `${status} ${code}`);
    assert.equal(info.message, 'm', 'request id suffix is stripped from the message');
    assert.equal(info.request_id, 'req_header');
    assert.ok(info.next_step.length > 10);
  }
  // The code decides, whatever status a proxy put on it.
  assert.equal(classifyGatewayError(403, { error: { code: 'insufficient_token_quota' } }).category, 'key_quota_exhausted');

  const relative = classifyGatewayError(402, { error: { code: 'insufficient_quota', action_url: '/dashboard/credits', account_balance_credits: 3.4, estimated_credits: 13.6, request_id: 'req_body' } });
  assert.equal(relative.action_url, 'https://evolink.ai/dashboard/credits');
  assert.equal(relative.request_id, 'req_body');
  assert.deepEqual(relative.details, { account_balance_credits: 3.4, estimated_credits: 13.6 });
  assert.match(relative.next_step, /3\.4 credits \(≈\$0\.05/);
  assert.match(relative.next_step, /13\.6 credits \(≈\$0\.2/);
  assert.equal(classifyGatewayError(402, { error: { code: 'insufficient_quota', action_url: '//evil.example/x' } }).action_url, 'https://evolink.ai/dashboard/credits');

  const daily = classifyGatewayError(402, { error: { code: 'token_daily_quota_exceeded', reset_timezone: 'Asia/Shanghai' } });
  assert.equal(daily.retryable, true);
  assert.match(daily.next_step, /Asia\/Shanghai/);
  assert.equal(classifyGatewayError(429, {}, 12_000).retry_after_seconds, 12);
  assert.match(classifyGatewayError(401, { error: { code: 'KEY_DISABLED' } }).next_step, /API key is disabled/);

  const files = classifyGatewayError(400, { success: false, code: 400, msg: 'file too large' });
  assert.equal(files.message, 'file too large');
  const oauth = classifyGatewayError(401, { error: 'invalid_token', error_description: 'expired' });
  assert.equal(oauth.code, 'invalid_token');
  assert.equal(oauth.message, 'expired');
});

test('error classification never throws and always gives a next step (seeded fuzz)', () => {
  const random = rng(20261005);
  const categories = new Set([
    'account_balance_insufficient', 'key_quota_exhausted', 'key_daily_quota_exhausted', 'key_disabled', 'key_expired',
    'model_not_allowed', 'unauthorized', 'forbidden', 'rate_limited', 'invalid_request', 'not_found', 'content_policy',
    'model_unavailable', 'idempotency_conflict', 'outcome_unknown', 'request_too_large', 'server_error',
  ]);
  const codes = [undefined, '', 'insufficient_quota', 'KEY_EXPIRED', 'channel:no_available_key', 'paid_outcome_unknown', 'x'.repeat(300), 42, null, {}];
  const bodies = [
    () => ({ error: { code: codes[Math.floor(random() * codes.length)], message: 'x'.repeat(Math.floor(random() * 2000)), account_balance_credits: random() > 0.5 ? random() * 100 : 'n/a' } }),
    () => ({ success: false, code: Math.floor(random() * 600), msg: 'files' }),
    () => ({ error: 'oops' }),
    () => 'plain text',
    () => null,
    () => [],
  ];
  for (let i = 0; i < 2_000; i++) {
    const status = 400 + Math.floor(random() * 200);
    const body = bodies[Math.floor(random() * bodies.length)]();
    const info = classifyGatewayError(status, body, random() > 0.5 ? Math.floor(random() * 60_000) : undefined);
    assert.ok(categories.has(info.category), info.category);
    assert.ok(info.next_step.length > 0);
    assert.ok(info.message.length <= 600);
    assert.equal(typeof info.retryable, 'boolean');
    if (info.action_url) assert.match(info.action_url, /^https:\/\/evolink\.ai\//);
  }
});

// --- parameter validation ---

test('the bundled parameter index covers image, video and audio models and its examples validate', () => {
  const specs = allModelParams();
  assert.ok(specs.length >= 100, `only ${specs.length} models`);
  for (const kind of ['image', 'video', 'audio']) assert.ok(specs.some(spec => spec.kind === kind), kind);
  assert.ok(imageSpec && imageSpec.kind === 'image');
  assert.ok(videoSpec && videoSpec.kind === 'video');
  for (const spec of specs) {
    assert.ok(!('callback_url' in spec.params), `${spec.model} exposes callback_url`);
    assert.match(spec.docs, /^https:\/\/evolink\.ai\/docs\/en\/api-manual\//);
    assert.match(spec.path, /^\/v1\/(images|videos|audios)\/generations$/);
    if (!spec.example) continue;
    // A docs example may leave out a required field; anything else means the index or the validator is wrong.
    const errors = validateInput(spec, spec.example).errors.filter(error => error.problem !== 'is required.');
    assert.deepEqual(errors, [], spec.model);
  }
});

test('validation catches unknown names, wrong types, choices and ranges before anything is sent', () => {
  const spec = {
    model: 'm', kind: 'video', path: '/v1/videos/generations', title: 't', docs: 'https://evolink.ai/docs/x', required: ['prompt'],
    params: {
      prompt: { type: 'string', required: true, maxLength: 10 },
      duration: { type: 'integer', minimum: 4, maximum: 12 },
      quality: { type: 'string', enum: ['720p', '1080p'] },
      image_urls: { type: 'array', maxItems: 2, items: { type: 'string' } },
      seed: { type: 'integer|string' },
      model_params: { type: 'object', properties: { web_search: { type: 'boolean' } } },
    },
  };
  const check = input => validateInput(spec, input);
  assert.deepEqual(check({ prompt: 'ok', duration: 5, quality: '720p', image_urls: ['a'], seed: 'x', model_params: { web_search: true } }), { errors: [], warnings: [] });
  const issues = input => check(input).errors.map(error => `${error.param} ${error.problem}`).join('\n');
  assert.match(issues({ prompt: 'ok', durration: 5 }), /durration is not a parameter here\. Did you mean "duration"\?/);
  assert.match(issues({ prompt: 'ok', duration: '5' }), /duration must be a whole number, got "5"\. Use 5 \(a number\)/);
  assert.match(issues({ prompt: 'ok', duration: 13 }), /duration must be at most 12/);
  assert.match(issues({ prompt: 'ok', duration: 4.5 }), /duration must be a whole number/);
  assert.match(issues({ prompt: 'ok', quality: '1080P' }), /quality use "1080p" \(values are case-sensitive\)/);
  assert.match(issues({ prompt: 'ok', quality: '4k' }), /quality must be one of "720p", "1080p"/);
  assert.match(issues({ prompt: 'ok', image_urls: ['a', 'b', 'c'] }), /image_urls allows at most 2 items/);
  assert.match(issues({ prompt: 'ok', image_urls: [1] }), /image_urls\[0\] must be a string/);
  assert.match(issues({ prompt: 'ok', model_params: { websearch: true } }), /model_params\.websearch is not a parameter here\. Did you mean "web_search"\?/);
  assert.match(issues({ duration: 5 }), /prompt is required/);
  assert.match(issues({ prompt: 'ok', callback_url: 'https://x.example' }), /callback_url callbacks are not available through MCP/);
  assert.match(issues({ prompt: 'ok', model: 'other' }), /model set the model with the model argument/);
  assert.deepEqual(check({ prompt: 'ok', model: 'm' }).errors, []);
  const long = check({ prompt: 'x'.repeat(11) });
  assert.equal(long.errors.length, 0, 'length limits are token-based upstream, so they only warn');
  assert.match(long.warnings[0].problem, /documented limit is 10/);
  assert.deepEqual(closestMatches('seedance-2-text-to-video', ['seedance-2.0-text-to-video', 'kling-v3'], 3), ['seedance-2.0-text-to-video']);
});

test('every documented model rejects generated bad inputs and accepts its own valid baseline (seeded)', () => {
  const random = rng(7);
  let mutations = 0;
  for (const spec of allModelParams()) {
    const baseline = { ...(spec.example ?? {}) };
    for (const name of spec.required) {
      if (baseline[name] !== undefined) continue;
      const param = spec.params[name];
      baseline[name] = param.enum?.[0] ?? (param.type?.startsWith('array') ? ['https://example.com/a.png'] : param.type?.includes('integer') || param.type?.includes('number') ? (param.minimum ?? 1) : 'x');
    }
    if (validateInput(spec, baseline).errors.length > 0) continue;
    const names = Object.keys(spec.params);
    const mutators = [
      input => ({ input: { ...input, [`${names[0] ?? 'x'}_typo`]: 1 }, param: `${names[0] ?? 'x'}_typo` }),
      input => {
        const name = names.find(key => spec.params[key].enum?.length && typeof spec.params[key].enum[0] === 'string');
        return name ? { input: { ...input, [name]: 'definitely-not-a-choice' }, param: name } : undefined;
      },
      input => {
        const name = names.find(key => spec.params[key].type === 'integer' && !spec.params[key].enum);
        return name ? { input: { ...input, [name]: 'twelve' }, param: name } : undefined;
      },
      input => {
        const name = names.find(key => typeof spec.params[key].maximum === 'number' && !spec.params[key].enum && /^(integer|number)$/.test(spec.params[key].type ?? ''));
        return name ? { input: { ...input, [name]: spec.params[name].maximum + 1 }, param: name } : undefined;
      },
      input => {
        const name = spec.required.find(key => input[key] !== undefined);
        if (!name) return undefined;
        const copy = { ...input };
        delete copy[name];
        return { input: copy, param: name };
      },
      input => {
        const name = names.find(key => spec.params[key].type === 'array');
        return name ? { input: { ...input, [name]: 'not-a-list' }, param: name } : undefined;
      },
    ];
    for (let round = 0; round < 3; round++) {
      const mutated = mutators[Math.floor(random() * mutators.length)](baseline);
      if (!mutated) continue;
      mutations++;
      const errors = validateInput(spec, mutated.input).errors;
      assert.ok(errors.some(error => error.param === mutated.param || error.param.startsWith(`${mutated.param}[`)), `${spec.model}: ${mutated.param} not reported`);
    }
  }
  assert.ok(mutations > 200, `only ${mutations} mutations ran`);
});

// --- pricing and estimates ---

test('SKU prices come from the routing note first and fall back to the raw fields', () => {
  assert.deepEqual(
    { ...skuPrice(PRICING[0]) },
    { sku_id: '1', name: 'Nano Banana 2', unit: 'image', min_usd: 0.086, max_usd: 0.094, role: 'output' },
  );
  assert.equal(skuPrice(PRICING[2]).role, 'add_on');
  assert.equal(skuPrice(PRICING[4]).role, 'token');
  assert.equal(skuPrice(PRICING[4]).unit, '1m tokens');
  const raw = skuPrice({ sku_id: 9, sku_name: 'Raw', model_name: 'r', model_type: 'video', billing_rule: 'per_second', cny_price: 0.68 });
  assert.equal(raw.unit, 'second');
  assert.ok(Math.abs(raw.min_usd - 0.1) < 1e-9);
  assert.equal(skuPrice({ sku_id: 10, sku_name: 'MiniMax H3 Reference to Video', model_name: 'r', model_type: 'video', billing_rule: 'per_second', cny_price: 1 }).role, 'output');
  assert.equal(skuPrice({ sku_id: 11, sku_name: 'MiniMax H3 Max Reference Video Seconds', model_name: 'r', model_type: 'video', billing_rule: 'per_second', cny_price: 1 }).role, 'add_on');
  assert.equal(skuPrice({ sku_id: 12, sku_name: 'Gemini-3-Pro-Image 输入图片', model_name: 'r', model_type: 'image', billing_rule: 'per_image', cny_price: 1 }).role, 'add_on');
  assert.equal(skuPrice({ sku_id: 13, sku_name: 'no price', model_name: 'r', model_type: 'image', billing_rule: 'per_call' }), undefined);
});

test('estimates multiply unit prices by count, seconds, tier and input images (cross combinations)', () => {
  const image = {
    id: 'img', kind: 'image', prices: [
      { sku_id: 'a', name: 'Img - 1K Output', unit: 'image', min_usd: 0.03, max_usd: 0.03, role: 'output' },
      { sku_id: 'b', name: 'Img - 2K Output', unit: 'image', min_usd: 0.06, max_usd: 0.07, role: 'output' },
      { sku_id: 'c', name: 'Img - Input Image', unit: 'image', min_usd: 0.002, max_usd: 0.002, role: 'add_on' },
    ],
  };
  for (const n of [undefined, 1, 2, 4]) {
    for (const quality of [undefined, '1K', '2K', '8K']) {
      for (const inputs of [0, 1, 3]) {
        const input = { prompt: 'p' };
        if (n !== undefined) input.n = n;
        if (quality) input.quality = quality;
        if (inputs) input.image_urls = Array.from({ length: inputs }, (_, i) => `https://x/${i}.png`);
        const estimate = estimateCost(image, 'image', input);
        const count = n ?? 1;
        const tiers = quality === '1K' ? [image.prices[0]] : quality === '2K' ? [image.prices[1]] : image.prices.slice(0, 2);
        const min = Math.min(...tiers.map(p => p.min_usd)) * count + 0.002 * inputs;
        const max = Math.max(...tiers.map(p => p.max_usd)) * count + 0.002 * inputs;
        const label = JSON.stringify(input);
        assert.equal(estimate.status, 'estimated', label);
        assert.ok(Math.abs(estimate.min_usd - min) < 1e-9, `${label} min ${estimate.min_usd} != ${min}`);
        assert.ok(Math.abs(estimate.max_usd - max) < 1e-9, `${label} max ${estimate.max_usd} != ${max}`);
        assert.ok(Math.abs(estimate.max_credits - max * 68) < 1e-6, label);
      }
    }
  }

  const video = {
    id: 'vid', kind: 'video', prices: [
      { sku_id: 'v', name: 'Vid Output', unit: 'second', min_usd: 0.1, max_usd: 0.12, role: 'output', multipliers: { '720p': 1, '1080p': 1.5 } },
    ],
  };
  const spec = { params: { duration: { type: 'integer', default: 5 } } };
  for (const duration of [undefined, 4, 10]) {
    for (const quality of [undefined, '720p', '1080p']) {
      const input = {};
      if (duration !== undefined) input.duration = duration;
      if (quality) input.quality = quality;
      const estimate = estimateCost(video, 'video', input, spec);
      const seconds = duration ?? 5;
      const [low, high] = quality === '720p' ? [1, 1] : quality === '1080p' ? [1.5, 1.5] : [1, 1.5];
      assert.ok(Math.abs(estimate.min_usd - 0.1 * seconds * low) < 1e-9, JSON.stringify(input));
      assert.ok(Math.abs(estimate.max_usd - 0.12 * seconds * high) < 1e-9, JSON.stringify(input));
    }
  }
  assert.equal(estimateCost(video, 'video', {}, { params: {} }).status, 'needs_input');
  assert.equal(estimateCost({ id: 't', kind: 'image', prices: [{ sku_id: 't', name: 'Tokens', unit: '1m tokens', min_usd: 27, max_usd: 27, role: 'token' }] }, 'image', {}).status, 'token_billed');
  assert.equal(estimateCost(undefined, 'image', {}).status, 'no_price');
  const minimum = estimateCost({ id: 'm', kind: 'video', prices: [{ sku_id: 'm', name: 'M', unit: 'request', min_usd: 0.01, max_usd: 0.01, role: 'output', min_charge_usd: 0.5 }] }, 'video', {});
  assert.equal(minimum.min_usd, 0.5);
});

// --- tools over MCP ---

test('exactly ten tools: paid ones are destructive, lookups are read-only, nothing reaches the open world', async () => {
  installGateway(baseRoutes());
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), TOOL_NAMES);
    for (const tool of tools) {
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
      assert.ok(tool.description.length <= 2_000, `${tool.name} description is ${tool.description.length} chars`);
      assert.ok(tool.name.length <= 30);
      assert.equal(tool.inputSchema.properties?.confirm_cost, undefined, `${tool.name} still asks the assistant to confirm`);
      if (PAID_TOOLS.includes(tool.name)) {
        assert.equal(tool.annotations.destructiveHint, true, tool.name);
        assert.equal(tool.annotations.readOnlyHint, false, tool.name);
        assert.match(tool.description, /PAID/);
        assert.match(tool.description, /estimate_cost/);
        assert.match(tool.description, /client_request_id/);
      } else if (tool.name === 'upload_file') {
        assert.equal(tool.annotations.readOnlyHint, false);
        assert.equal(tool.annotations.destructiveHint, false);
      } else {
        assert.equal(tool.annotations.readOnlyHint, true, tool.name);
      }
    }
    assert.ok(!tools.some(tool => /cancel/.test(tool.name)), 'no cancel tool');
    assert.match(client.getInstructions(), /estimate_cost/);
    assert.match(client.getInstructions(), /Never call a generate tool again to check progress/);
  } finally {
    await close();
  }
});

test('generate_image validates, submits once with the client key and returns the finished image', async () => {
  let reads = 0;
  const calls = installGateway(baseRoutes({
    'POST /v1/images/generations': () => json(200, task('task_img_1', 'pending', { usage: { credits_reserved: 6.4 } }), { 'x-request-id': 'req_submit' }),
    'GET /v1/tasks/:id': () => {
      reads++;
      return reads < 2
        ? json(200, task('task_img_1', 'processing'))
        : json(200, task('task_img_1', 'completed', { results: ['https://files.evolink.ai/out/1.png'], usage: { credits_used: 6.12, cost: { credits: 6.12, usd: 0.09 } } }));
    },
  }));
  const { client, close } = await connect('Claude Code Test');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { model: IMAGE_MODEL, prompt: 'a red apple', input: {}, client_request_id: 'req-apple-0000000001' },
    });
    const text = textOf(result);
    assert.notEqual(result.isError, true, text);
    const submits = calls.filter(call => call.path === '/v1/images/generations');
    assert.equal(submits.length, 1);
    const submit = submits[0];
    assert.equal(submit.headers.get('idempotency-key'), 'req-apple-0000000001');
    assert.equal(submit.headers.get('x-evo-client'), 'mcp');
    assert.equal(submit.headers.get('x-evo-tool'), 'generate_image');
    assert.equal(submit.headers.get('x-evo-client-name'), 'Claude Code Test');
    assert.equal(submit.headers.get('authorization'), 'Bearer sk-test-only');
    assert.deepEqual(submit.body, { prompt: 'a red apple', model: IMAGE_MODEL });
    assert.match(text, /https:\/\/files\.evolink\.ai\/out\/1\.png/);
    assert.match(text, /expire after 24 hours/);
    assert.match(text, /Charged: 6\.12 credits/);
    assert.match(text, /client_request_id: req-apple-0000000001/);
    assert.equal(result.structuredContent.ok, true);
    assert.equal(result.structuredContent.status, 'completed');
    assert.deepEqual(result.structuredContent.results, [{ url: 'https://files.evolink.ai/out/1.png', kind: 'image' }]);
    assert.deepEqual(result.structuredContent.submitted, { model: IMAGE_MODEL, input: { prompt: 'a red apple' } });
    assert.equal(result.structuredContent.charged_usd, 0.09);
    assert.equal(reads, 2);
  } finally {
    await close();
  }
});

test('generate_video returns the task at once and points at get_task instead of resubmitting', async () => {
  const calls = installGateway(baseRoutes({
    'POST /v1/videos/generations': () => json(200, { ...task('task_vid_1', 'pending'), model: VIDEO_MODEL, type: 'video', task_info: { estimated_time: 120 }, usage: { credits_reserved: 68 } }),
  }));
  const { client, close } = await connect();
  try {
    const result = await client.callTool({ name: 'generate_video', arguments: { model: VIDEO_MODEL, input: validVideoInput() } });
    const text = textOf(result);
    assert.notEqual(result.isError, true, text);
    assert.equal(calls.filter(call => call.path.startsWith('/v1/tasks/')).length, 0, 'video submit does not wait');
    assert.match(text, /Task task_vid_1: pending/);
    assert.match(text, /call get_task with task_id "task_vid_1"/);
    assert.match(text, /Do not call generate again/);
    assert.match(text, /Reserved: 68 credits \(≈\$1\.00\)/);
    assert.match(text, /Estimate before submitting: \$/);
    assert.match(result.structuredContent.client_request_id, /^run_[a-f0-9]{32}$/);
  } finally {
    await close();
  }
});

test('generate refuses bad input, wrong kind, unknown models and blocked params without submitting', async () => {
  const calls = installGateway(baseRoutes({
    'POST /v1/images/generations': () => json(200, task('never', 'pending')),
    'POST /v1/videos/generations': () => json(200, task('never', 'pending')),
  }));
  const { client, close } = await connect();
  try {
    const cases = [
      [{ model: IMAGE_MODEL, prompt: 'x', input: { prompt_typo: 'y' } }, 'generate_image', /prompt_typo is not a parameter here/],
      [{ model: IMAGE_MODEL, prompt: 'x', input: { callback_url: 'https://evil.example/hook' } }, 'generate_image', /callbacks are not available/],
      [{ model: VIDEO_MODEL, prompt: 'x' }, 'generate_image', /is a video model; use generate_video/],
      [{ model: 'gemini-3.1-flash-image-previe', prompt: 'x' }, 'generate_image', /Unknown image model .*Did you mean: gemini-3\.1-flash-image-preview/],
      [{ model: IMAGE_MODEL, prompt: 'a', input: { prompt: 'b' } }, 'generate_image', /prompt was given twice/],
    ];
    for (const [args, name, pattern] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(textOf(result), pattern);
      assert.match(textOf(result), /Nothing was submitted or charged|nothing was submitted or charged/);
      assert.equal(result.structuredContent.ok, false);
    }
    assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/generations')).length, 0);
  } finally {
    await close();
  }
});

test('max_cost_usd blocks a submit above the estimate and lets a cheaper one through', async () => {
  const calls = installGateway(baseRoutes({
    'POST /v1/videos/generations': () => json(200, { ...task('task_cap', 'pending'), type: 'video' }),
    'POST /v1/images/generations': () => json(200, task('never', 'pending')),
  }));
  const { client, close } = await connect();
  try {
    const input = validVideoInput();
    const cost = 0.219 * input.duration;
    const blocked = await client.callTool({ name: 'generate_video', arguments: { model: VIDEO_MODEL, input, max_cost_usd: cost / 2 } });
    assert.equal(blocked.isError, true);
    assert.match(textOf(blocked), /is above max_cost_usd/);
    assert.equal(calls.filter(call => call.path === '/v1/videos/generations').length, 0);

    const allowed = await client.callTool({ name: 'generate_video', arguments: { model: VIDEO_MODEL, input, max_cost_usd: cost + 0.01 } });
    assert.notEqual(allowed.isError, true, textOf(allowed));
    assert.equal(calls.filter(call => call.path === '/v1/videos/generations').length, 1);

    const tokens = await client.callTool({ name: 'generate_image', arguments: { model: 'gpt-image-2', prompt: 'x', max_cost_usd: 1 } });
    assert.equal(tokens.isError, true);
    assert.match(textOf(tokens), /cannot be checked .* billed by tokens/);
  } finally {
    await close();
  }
});

test('paid rejections explain the next step; a lost connection returns the key to retry safely', async () => {
  let mode = 'quota';
  const keys = [];
  installGateway(baseRoutes({
    'POST /v1/images/generations': call => {
      keys.push(call.headers.get('idempotency-key'));
      if (mode === 'quota') {
        return json(402, { error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'Insufficient account balance. (request id: req_q)', action_url: '/dashboard/credits', account_balance_credits: 1.2, estimated_credits: 6.4, request_id: 'req_q' } });
      }
      if (mode === 'replay') return json(200, task('task_original', 'completed', { results: ['https://files.evolink.ai/o.png'] }), { 'idempotency-replayed': 'true' });
      throw new TypeError('connection reset');
    },
    'GET /v1/tasks/:id': () => json(200, task('task_original', 'completed', { results: ['https://files.evolink.ai/o.png'] })),
  }));
  const { client, close } = await connect();
  try {
    const quota = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'x' } });
    assert.equal(quota.isError, true);
    const quotaText = textOf(quota);
    assert.match(quotaText, /account_balance_insufficient/);
    assert.match(quotaText, /https:\/\/evolink\.ai\/dashboard\/credits/);
    assert.match(quotaText, /Balance: 1\.2 credits/);
    assert.match(quotaText, /Nothing was submitted or charged/);
    assert.match(quotaText, /Request ID: req_q/);
    assert.equal(quota.structuredContent.charged, 'no');
    assert.equal(keys.length, 1, 'balance rejections are not retried');

    mode = 'network';
    keys.length = 0;
    const lost = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'x', client_request_id: 'lost-request-000000001' } });
    assert.equal(lost.isError, true);
    assert.equal(lost.structuredContent.charged, 'unknown');
    assert.equal(lost.structuredContent.client_request_id, 'lost-request-000000001');
    assert.match(textOf(lost), /pass client_request_id "lost-request-000000001"/);
    assert.deepEqual(keys, ['lost-request-000000001', 'lost-request-000000001']);

    mode = 'replay';
    const replay = await client.callTool({ name: 'generate_image', arguments: { model: IMAGE_MODEL, prompt: 'x', client_request_id: 'lost-request-000000001' } });
    assert.notEqual(replay.isError, true, textOf(replay));
    assert.match(textOf(replay), /returning the original task \(no new charge\)/);
    assert.equal(replay.structuredContent.replayed, true);
  } finally {
    await close();
  }
});

test('get_task waits for completion, reports failures with refunds, and returns at once with wait 0', async () => {
  let reads = 0;
  let script = [];
  installGateway(baseRoutes({ 'GET /v1/tasks/:id': () => json(200, script[Math.min(reads++, script.length - 1)]) }));
  const { client, close } = await connect();
  try {
    script = [task('task_t1', 'processing'), task('task_t1', 'processing'), task('task_t1', 'completed', { type: 'video', results: ['https://files.evolink.ai/v.mp4'], usage: { credits_used: 68 } })];
    const done = await client.callTool({ name: 'get_task', arguments: { task_id: 'task_t1', wait_seconds: 10 } });
    assert.match(textOf(done), /Task task_t1: completed/);
    assert.match(textOf(done), /video: https:\/\/files\.evolink\.ai\/v\.mp4/);
    assert.match(textOf(done), /Charged: 68 credits \(≈\$1\.00\)/);
    assert.equal(reads, 3);

    reads = 0;
    script = [task('task_t2', 'failed', { error: { code: 'content_policy_violation', message: 'blocked' } })];
    const failed = await client.callTool({ name: 'get_task', arguments: { task_id: 'task_t2' } });
    assert.notEqual(failed.isError, true, 'a failed task is a valid answer, not a tool error');
    assert.match(textOf(failed), /Error: content_policy_violation — blocked/);
    assert.match(textOf(failed), /failed tasks are refunded/);
    assert.equal(failed.structuredContent.error.retryable, false);

    reads = 0;
    script = [task('task_t3', 'processing')];
    const quick = await client.callTool({ name: 'get_task', arguments: { task_id: 'task_t3', wait_seconds: 0 } });
    assert.equal(reads, 1);
    assert.match(textOf(quick), /call get_task with task_id "task_t3" again/);

    // Depending on the SDK version a schema violation is a tool error or a protocol error; either way nothing runs.
    const bad = await client.callTool({ name: 'get_task', arguments: { task_id: '../etc/passwd' } }).catch(error => ({ isError: true, error }));
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
});

test('list_tasks reads IDs in one batch and recent tasks with links for finished ones', async () => {
  const calls = installGateway(baseRoutes({
    'POST /v1/tasks/batch': call => json(200, {
      code: 200,
      data: call.body.task_ids.filter(id => id !== 'missing').map(id => task(id, 'completed', { results: [`https://files.evolink.ai/${id}.png`], usage: { credits_used: 1 } })),
    }),
    'GET /v1/tasks': () => json(200, {
      object: 'list', total: 3, page: 1, page_size: 20,
      data: [
        { id: 'new_done', model: IMAGE_MODEL, type: 'image', status: 'completed', progress: 100, created_at: Math.floor(Date.now() / 1000) - 60, has_results: true, result_count: 1, credits_used: 1 },
        { id: 'new_run', model: VIDEO_MODEL, type: 'video', status: 'processing', progress: 30, created_at: Math.floor(Date.now() / 1000) - 30 },
        { id: 'old_done', model: IMAGE_MODEL, type: 'image', status: 'completed', progress: 100, created_at: Math.floor(Date.now() / 1000) - 7_200, has_results: true },
      ],
    }),
  }));
  const { client, close } = await connect();
  try {
    const byIds = await client.callTool({ name: 'list_tasks', arguments: { task_ids: ['task_a1', 'missing', 'task_a1'] } });
    assert.match(textOf(byIds), /1 of 2 tasks found/);
    assert.match(textOf(byIds), /https:\/\/files\.evolink\.ai\/task_a1\.png/);
    assert.deepEqual(byIds.structuredContent.missing, ['missing']);
    assert.deepEqual(calls.at(-1).body, { task_ids: ['task_a1', 'missing'] });

    const recent = await client.callTool({ name: 'list_tasks', arguments: { since: '1h', limit: 20 } });
    const text = textOf(recent);
    assert.match(text, /new_done/);
    assert.match(text, /new_run/);
    assert.doesNotMatch(text, /old_done/);
    assert.match(text, /https:\/\/files\.evolink\.ai\/new_done\.png/);
    const list = calls.find(call => call.method === 'GET' && call.path === '/v1/tasks');
    assert.equal(list.query.get('page_size'), '20');
    assert.deepEqual(calls.at(-1).body, { task_ids: ['new_done'] }, 'only finished tasks inside the window are read for links');

    const bad = await client.callTool({ name: 'list_tasks', arguments: { since: 'yesterday-ish' } });
    assert.equal(bad.isError, true);
  } finally {
    await close();
  }
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(parseSince('30m', now), now - 1_800_000);
  assert.equal(parseSince('2h', now), now - 7_200_000);
  assert.equal(parseSince('1d', now), now - 86_400_000);
  assert.equal(parseSince('2026-10-05T08:00:00Z', now), Date.parse('2026-10-05T08:00:00Z'));
  assert.equal(parseSince('1790000000', now), 1_790_000_000_000);
  assert.equal(parseSince('soon', now), undefined);
});

test('check_balance shows the balance, the key spend and the top-up link', async () => {
  let token = { remaining_credits: 99999.9999, used_credits: 6.8, unlimited_credits: true };
  let user = { remaining_credits: 340, used_credits: 12 };
  installGateway(baseRoutes({ 'GET /v1/credits': () => json(200, { success: true, data: { user, token } }) }));
  const { client, close } = await connect();
  try {
    const unlimited = await client.callTool({ name: 'check_balance', arguments: {} });
    assert.match(textOf(unlimited), /Account balance: 340 credits \(≈\$5\.00\)/);
    assert.match(textOf(unlimited), /This API key has spent 6\.8 credits/);
    assert.match(textOf(unlimited), /no spending limit of its own/);
    assert.match(textOf(unlimited), /https:\/\/evolink\.ai\/dashboard\/credits/);
    assert.equal(unlimited.structuredContent.has_limit, false);

    token = { remaining_credits: 20, used_credits: 48, unlimited_credits: false };
    user = { remaining_credits: -3, used_credits: 900 };
    const limited = await client.callTool({ name: 'check_balance', arguments: {} });
    assert.match(textOf(limited), /Account balance: 0 credits/);
    assert.match(textOf(limited), /20 credits \(≈\$0\.294\) of its limit is left/);
    assert.match(textOf(limited), /balance is low/);
  } finally {
    await close();
  }
});

test('search_models, get_model and estimate_cost use documented parameters and live prices', async () => {
  let pricingUp = true;
  installGateway(baseRoutes({
    'GET /web/api/models/pricing': () => (pricingUp ? json(200, { success: true, data: PRICING }) : json(503, {})),
  }));
  const { client, close } = await connect();
  try {
    const search = await client.callTool({ name: 'search_models', arguments: { query: 'banana', type: 'image' } });
    const searchText = textOf(search);
    assert.match(searchText, new RegExp(`${IMAGE_MODEL.replaceAll('.', '\\.')} \\[image\\]`));
    assert.match(searchText, /from \$0\.086–\$0\.094 per image/);
    assert.ok(search.structuredContent.models.every(model => model.type === 'image'));
    const pricedOnly = await client.callTool({ name: 'search_models', arguments: { query: 'priced-only' } });
    assert.match(textOf(pricedOnly), /priced-only-video \[video\].*parameters not documented/);
    const text = await client.callTool({ name: 'search_models', arguments: { query: 'some-chat' } });
    assert.match(textOf(text), /^0 models match/, 'text models are not offered');

    const model = await client.callTool({ name: 'get_model', arguments: { model: IMAGE_MODEL } });
    const modelText = textOf(model);
    assert.match(modelText, /Generate with: generate_image/);
    assert.match(modelText, /- prompt \(string, required\)/);
    assert.match(modelText, /Main charge:\n- Nano Banana 2: \$0\.086–\$0\.094 per image/);
    assert.match(modelText, /Extra charges:\n- Nano Banana 2 - Input Image: \$0\.0005 per image/);
    assert.equal(model.structuredContent.tool, 'generate_image');
    assert.ok(model.structuredContent.parameters.prompt);
    const unknown = await client.callTool({ name: 'get_model', arguments: { model: 'seedance-2-text-to-video' } });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /Did you mean: .*seedance-2\.0-text-to-video/);

    const quality = imageSpec.params.quality?.enum?.includes('4K') ? '4K' : undefined;
    const estimate = await client.callTool({
      name: 'estimate_cost',
      arguments: { model: IMAGE_MODEL, input: { ...validImageInput(), ...(quality ? { quality } : {}), image_urls: ['https://x/a.png', 'https://x/b.png'] } },
    });
    const estimateText = textOf(estimate);
    assert.match(estimateText, /nothing was submitted or charged/);
    assert.match(estimateText, /Input looks valid/);
    assert.match(estimateText, quality ? /Estimated cost: \$0\.130–\$0\.142 \(8\.84–9\.66 credits\)/ : /Estimated cost: \$/);
    assert.match(estimateText, /Account balance: 340 credits/);
    assert.equal(estimate.structuredContent.enough_balance, true);
    const invalid = await client.callTool({ name: 'estimate_cost', arguments: { model: IMAGE_MODEL, input: { promt: 'x' } } });
    assert.match(textOf(invalid), /Input problems .*\n- promt is not a parameter here\. Did you mean "prompt"\?/);

    pricingUp = false;
    resetPricingCacheForTests();
    const offline = await client.callTool({ name: 'get_model', arguments: { model: IMAGE_MODEL } });
    assert.notEqual(offline.isError, true);
    assert.match(textOf(offline), /Prices are unavailable right now/);
  } finally {
    await close();
  }
});

test('upload_file needs no confirmation flag, refuses unsafe sources locally and returns a link', async () => {
  const calls = installGateway({
    'POST /api/v1/files/upload/url': () => json(200, {
      success: true, code: 200, msg: 'ok',
      data: { file_id: 'file_1', file_name: 'a.png', original_name: 'a.png', file_size: 2048, mime_type: 'image/png', upload_path: '', file_url: 'https://files.evolink.ai/a.png', download_url: 'https://files.evolink.ai/a.png?dl=1', upload_time: 'now', expires_at: '2026-10-08T00:00:00Z' },
    }),
  });
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    const upload = tools.find(tool => tool.name === 'upload_file');
    assert.equal(upload.inputSchema.properties.confirm_upload, undefined);
    assert.ok(upload.inputSchema.properties.file_path, 'stdio keeps local paths behind the allowlist');

    const refused = await client.callTool({ name: 'upload_file', arguments: { file_url: 'https://127.0.0.1/a.png' } });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /Upload refused: file_url must not target a loopback or private address/);
    assert.equal(calls.length, 0);

    const ok = await client.callTool({ name: 'upload_file', arguments: { file_url: 'https://cdn.example.com/a.png' } });
    assert.match(textOf(ok), /File URL: https:\/\/files\.evolink\.ai\/a\.png/);
    assert.equal(ok.structuredContent.file_url, 'https://files.evolink.ai/a.png');
    assert.equal(calls[0].headers.get('x-evo-tool'), 'upload_file');
  } finally {
    await close();
  }
});

// --- router package (unchanged behaviour) ---

test('router paid retry keeps one model and one idempotency intent on unknown outcome', async () => {
  let paidCalls = 0;
  const paidKeys = [];
  globalThis.fetch = async (url, init) => {
    if (new URL(url).hostname === 'control.example') {
      return json(200, {
        meta: { schema_version: '1', catalog_version: 'cat_router', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'claude-haiku-4-5-20251001', display_name: 'Haiku', provider: 'Anthropic', aliases: [], capabilities: ['text'], protocols: ['anthropic-messages'], lifecycle: 'active' }],
      });
    }
    paidCalls++;
    paidKeys.push(new Headers(init.headers).get('idempotency-key'));
    throw new TypeError('connection reset');
  };
  await assert.rejects(
    chatRequest({ baseUrl: 'https://direct.example' }, { model: 'claude-haiku-4-5-20251001', prompt: 'hello', maxTokens: 16 }),
    RouterOutcomeUnknownError,
  );
  assert.equal(paidCalls, 2);
  assert.deepEqual(paidKeys, [paidKeys[0], paidKeys[0]]);
});

test('router resolves a new model and protocol from canonical Catalog', async () => {
  let paidPath = '';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === 'control.example') {
      return json(200, {
        meta: { schema_version: '1', catalog_version: 'cat_new', updated_at: '2026-07-15T12:00:00Z', fresh_until: '2026-07-15T12:05:00Z' },
        models: [{ model_id: 'new-live-model', display_name: 'New Live', provider: 'Example', aliases: ['new-alias'], capabilities: ['text'], protocols: ['openai-chat-completions'], lifecycle: 'active' }],
      });
    }
    paidPath = parsed.pathname;
    assert.match(new Headers(init.headers).get('idempotency-key') ?? '', /^run_/);
    return json(200, { model: 'new-live-model', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }, { 'x-request-id': 'req_new' });
  };
  const response = await chatRequest({ baseUrl: 'https://direct.example' }, { model: 'new-alias', prompt: 'hello', maxTokens: 16 });
  assert.equal(paidPath, '/v1/chat/completions');
  assert.equal(response.catalogVersion, 'cat_new');
  assert.equal(response.requestId, 'req_new');
  assert.equal(response.usage.outputTokens, 1);
});

test('router paid tools keep their explicit confirmations', () => {
  const registrations = [];
  const server = { tool: (...args) => registrations.push(args) };
  registerDelegate(server, { baseUrl: 'https://direct.example' });
  registerCascade(server, { baseUrl: 'https://direct.example' });
  const byName = name => registrations.find(args => args[0] === name);
  assert.equal(byName('delegate')[2].confirm_paid_request.safeParse(false).success, false);
  assert.equal(byName('cascade')[2].max_steps.parse(undefined), 1);
  assert.equal(byName('cascade')[2].confirm_paid_requests.safeParse(false).success, false);
});

// --- local file policy ---

test('local upload policy enforces allowlist, resolved path, size, and MIME signature', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolink-upload-'));
  const allowed = join(root, 'allowed');
  const outside = join(root, 'outside');
  await mkdir(allowed);
  await mkdir(outside);
  const png = join(allowed, 'ok.png');
  await writeFile(png, Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('test payload')]));
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

// --- real stdio process ---

test('real stdio server: ten tools, instructions, assistant name header, and live prices', async () => {
  const seen = [];
  const gateway = createHTTPServer((request, response) => {
    seen.push({ path: request.url, name: request.headers['x-evo-client-name'], client: request.headers['x-evo-client'] });
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/web/api/models/pricing')) {
      response.end(JSON.stringify({ success: true, data: PRICING }));
      return;
    }
    if (request.url === '/v1/credits') {
      response.end(JSON.stringify({ success: true, data: { user: { remaining_credits: 68, used_credits: 0 }, token: { remaining_credits: 0, used_credits: 0, unlimited_credits: true } } }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['packages/evolink-media/dist/evolink-media/src/index.js'],
    cwd: process.cwd(),
    env: { EVOLINK_API_KEY: 'sk-stdio-test', EVOLINK_BASE_URL: base, EVOLINK_CONTROL_BASE: base, EVOLINK_MCP_READ_TIMEOUT_MS: '5000' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), TOOL_NAMES);
    assert.match(client.getInstructions(), /quote|price/i);
    assert.equal(client.getServerVersion().name, 'evolink-mcp');
    const search = await client.callTool({ name: 'search_models', arguments: { query: 'banana' } });
    assert.match(textOf(search), new RegExp(IMAGE_MODEL.replaceAll('.', '\\.')));
    const balance = await client.callTool({ name: 'check_balance', arguments: {} });
    assert.match(textOf(balance), /Account balance: 68 credits \(≈\$1\.00\)/);
    const credits = seen.find(item => item.path === '/v1/credits');
    assert.equal(credits.client, 'mcp');
    assert.equal(credits.name, 'stdio-test-client');
  } finally {
    await client.close();
    await new Promise(resolve => gateway.close(resolve));
  }
});
