import { randomUUID } from 'node:crypto';
import type { RouterConfig } from '../config.js';
import { getApiKey } from '../config.js';
import { findModel } from '../data/text-models.js';
import { getAdapter, type ChatRequest, type ChatResponse } from './api-adapters.js';
import { catalogApiFormat, getTextCatalog } from './catalog-client.js';
import { formatApiError } from './error-handler.js';

const DEFAULT_WRITE_TIMEOUT_MS = 120_000;

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export class PaidRequestOutcomeUnknownError extends Error {
  constructor(public readonly cause: unknown) {
    super('paid routing request outcome is unknown; do not retry or escalate automatically');
    this.name = 'PaidRequestOutcomeUnknownError';
  }
}

function writeTimeoutMs(): number {
  const raw = process.env.EVOLINK_MCP_WRITE_TIMEOUT_MS;
  if (!raw) return DEFAULT_WRITE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error('EVOLINK_MCP_WRITE_TIMEOUT_MS must be an integer between 1000 and 600000 milliseconds');
  }
  return parsed;
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 2_000) };
  }
}

function requestId(response: Response): string | undefined {
  return response.headers.get('x-request-id')?.trim()
    || response.headers.get('x-oneapi-request-id')?.trim()
    || undefined;
}

async function rawChatRequest(
  config: RouterConfig,
  req: ChatRequest,
): Promise<ChatResponse> {
  const fallback = findModel(req.model);
  let apiFormat = fallback?.apiFormat;
  let catalogVersion: string | undefined;
  let catalogSource: string | undefined;
  let warning: string | undefined;
  let catalogLoaded = false;
  try {
    const catalog = await getTextCatalog();
    catalogLoaded = true;
    const requested = req.model.toLowerCase();
    const model = catalog.data.models.find(value => value.model_id.toLowerCase() === requested || value.aliases.some(alias => alias.toLowerCase() === requested));
    if (!model || model.lifecycle === 'retired') {
      throw new Error(`Unknown or retired canonical model: "${req.model}". Use list_text_models to see available models.`);
    }
    apiFormat = catalogApiFormat(model);
    catalogVersion = catalog.data.meta.catalog_version;
    catalogSource = catalog.source;
    warning = catalog.warning;
  } catch (error) {
    if (catalogLoaded || !fallback) throw error;
    warning = `Canonical Catalog is unavailable; using bundled protocol metadata for ${fallback.name}.`;
    catalogSource = 'bundled-fallback';
  }
  if (!apiFormat) throw new Error(`No supported protocol is available for "${req.model}".`);

  const adapter = getAdapter(apiFormat);
  const { path, body } = adapter.buildRequest(req);
  const url = `${config.baseUrl}${path}`;
  const runId = `run_${randomUUID().replaceAll('-', '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), writeTimeoutMs());
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': runId,
        'X-Evo-Client': 'mcp',
        'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
        'X-Evo-Tool': 'router',
        'X-Evo-Run-Id': runId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new PaidRequestOutcomeUnknownError(error);
  } finally {
    clearTimeout(timer);
  }

  const data = await responseBody(response);
  const responseRequestId = requestId(response);
  if (!response.ok) {
    throw new ApiHttpError(response.status, formatApiError(response.status, data), responseRequestId);
  }
  return {
    ...adapter.parseResponse(data), requestId: responseRequestId,
    catalogVersion, catalogSource, warning,
  };
}

/** Send exactly one paid chat POST. Network and timeout failures are never retried automatically. */
export async function chatRequest(
  config: RouterConfig,
  req: ChatRequest,
): Promise<ChatResponse> {
  return rawChatRequest(config, req);
}
