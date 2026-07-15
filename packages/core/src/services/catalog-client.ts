import { isIP } from 'node:net';
import { ApiHttpError, withRetry } from './api-client.js';
import { getApiKey } from '../config.js';
import {
  DEFAULT_READ_TIMEOUT_MS,
  fetchWithTimeout,
  parseRetryAfter,
  readJsonBody,
  responseRequestId,
  timeoutFromEnv,
} from './http-policy.js';

const CACHE_TTL_MS = 5 * 60_000;
const MAX_STALE_MS = 24 * 60 * 60_000;

export interface CatalogMeta {
  schema_version: string;
  catalog_version: string;
  updated_at: string;
  fresh_until: string;
}

export interface CatalogModel {
  model_id: string;
  display_name: string;
  provider: string;
  aliases: string[];
  capabilities: string[];
  protocols: string[];
  lifecycle: 'preview' | 'active' | 'deprecated' | 'retired';
  deprecates_at?: string | null;
}

export interface CatalogModelsResponse {
  meta: CatalogMeta;
  models: CatalogModel[];
}

export interface CatalogPrice {
  sku_id: string;
  model_id: string;
  role: string;
  currency: string;
  unit: string;
  price: string;
  official_price?: string | null;
  effective_at: string;
  source_url?: string | null;
}

export interface CatalogPricingResponse {
  meta: CatalogMeta;
  prices: CatalogPrice[];
}

export interface CatalogHealthResponse {
  meta: CatalogMeta;
  models: Array<{ model_id: string; status: string; observed_at: string }>;
}

export interface CatalogSetupResponse {
  meta: CatalogMeta;
  client: string;
  model_id: string;
  environment: Record<string, string>;
  config: Record<string, unknown>;
  warnings: string[];
}

export interface WorkloadEstimateInput {
  input_tokens?: number;
  max_output_tokens?: number;
  count?: number;
  duration_seconds?: number;
  quality?: string;
}

export interface WorkloadEstimateResponse {
  estimate_id: string;
  catalog_version: string;
  model_id: string;
  operation: 'text-generation' | 'image-generation' | 'video-generation' | 'audio-generation';
  currency: string;
  amount: string;
  estimated_usage: WorkloadEstimateInput;
  assumptions: string[];
  expires_at: string;
}

export interface RequestDiagnosisResponse {
  request_id: string;
  status: string;
  findings: string[];
  recovery_actions: string[];
  observed_at: string;
}

export interface CatalogResult<T> {
  data: T;
  source: 'live' | 'cache' | 'stale-cache';
  warning?: string;
}

export class CatalogModelUnavailableError extends Error {
  constructor(modelId: string, capability: string) {
    super(`Canonical Catalog does not expose active ${capability} model ${modelId}`);
    this.name = 'CatalogModelUnavailableError';
  }
}

interface CacheEntry<T> {
  data: T;
  etag?: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function controlBaseURL(): string {
  const configured = (process.env.EVOLINK_CONTROL_BASE ?? 'https://api.evolink.ai').trim().replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('EVOLINK_CONTROL_BASE must be an absolute URL');
  }
  const loopback = parsed.hostname === 'localhost' || (isIP(parsed.hostname) !== 0 && parsed.hostname === '127.0.0.1');
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('EVOLINK_CONTROL_BASE must use HTTPS, except for loopback development, and contain no credentials/query/fragment');
  }
  return configured;
}

export async function estimateWorkload(
  modelId: string,
  operation: WorkloadEstimateResponse['operation'],
  input: WorkloadEstimateInput,
): Promise<WorkloadEstimateResponse> {
  return withRetry(async () => {
    const response = await fetchWithTimeout(`${controlBaseURL()}/v1/agent-estimates`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'X-Evo-Client': 'mcp',
        'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
        'X-Evo-Tool': 'estimate_cost',
      },
      body: JSON.stringify({ model_id: modelId, operation, input }),
    }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    const data = await readJsonBody(response);
    if (!response.ok) {
      const message = (data as { error?: { message?: string } }).error?.message ?? `Estimate HTTP ${response.status}`;
      throw new ApiHttpError(
        response.status,
        message,
        parseRetryAfter(response.headers.get('retry-after')),
        responseRequestId(response.headers),
      );
    }
    const estimate = data as Partial<WorkloadEstimateResponse>;
    if (!estimate.estimate_id || !estimate.catalog_version || !estimate.amount || !estimate.currency) {
      throw new Error('Estimate returned an invalid versioned envelope');
    }
    return estimate as WorkloadEstimateResponse;
  }, 2, 500);
}

export async function diagnoseRequest(requestId: string): Promise<RequestDiagnosisResponse> {
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(requestId)) throw new Error('request_id is invalid');
  const response = await withRetry(async () => {
    const value = await fetchWithTimeout(`${controlBaseURL()}/v1/agent-diagnosis/requests/${encodeURIComponent(requestId)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
        'X-Evo-Client': 'mcp',
        'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
        'X-Evo-Tool': 'diagnose_request',
      },
    }, timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS));
    if (!value.ok) {
      const data = await readJsonBody(value);
      const message = (data as { error?: { message?: string } }).error?.message ?? `Diagnosis HTTP ${value.status}`;
      throw new ApiHttpError(value.status, message, parseRetryAfter(value.headers.get('retry-after')), responseRequestId(value.headers));
    }
    return value;
  }, 2, 500);
  const data = await readJsonBody(response) as Partial<RequestDiagnosisResponse>;
  if (data.request_id !== requestId || !Array.isArray(data.findings) || !Array.isArray(data.recovery_actions)) {
    throw new Error('Diagnosis returned an invalid envelope');
  }
  return data as RequestDiagnosisResponse;
}

function validCatalogEnvelope(value: unknown): value is { meta: CatalogMeta } {
  if (!value || typeof value !== 'object') return false;
  const meta = (value as { meta?: Partial<CatalogMeta> }).meta;
  return !!meta && typeof meta.catalog_version === 'string' && meta.catalog_version !== ''
    && typeof meta.schema_version === 'string' && meta.schema_version !== '';
}

async function loadCatalog<T>(path: string, tool: string): Promise<CatalogResult<T>> {
  const now = Date.now();
  const existing = cache.get(path) as CacheEntry<T> | undefined;
  if (existing && now - existing.fetchedAt < CACHE_TTL_MS) {
    return { data: existing.data, source: 'cache' };
  }
  try {
    const response = await withRetry(async () => {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
        'X-Evo-Client': 'mcp',
        'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
        'X-Evo-Tool': tool,
      };
      if (existing?.etag) headers['If-None-Match'] = existing.etag;
      const value = await fetchWithTimeout(
        `${controlBaseURL()}${path}`,
        { method: 'GET', headers },
        timeoutFromEnv('EVOLINK_MCP_READ_TIMEOUT_MS', DEFAULT_READ_TIMEOUT_MS),
      );
      if (value.status === 304 && existing) return value;
      if (!value.ok) {
        const data = await readJsonBody(value);
        const message = (data as { error?: { message?: string } }).error?.message ?? `Catalog HTTP ${value.status}`;
        throw new ApiHttpError(
          value.status,
          message,
          parseRetryAfter(value.headers.get('retry-after')),
          responseRequestId(value.headers),
        );
      }
      return value;
    }, 2, 500);

    if (response.status === 304 && existing) {
      existing.fetchedAt = now;
      return { data: existing.data, source: 'cache' };
    }
    const data = await readJsonBody(response);
    if (!validCatalogEnvelope(data)) throw new Error('Catalog returned an invalid versioned envelope');
    cache.set(path, { data, etag: response.headers.get('etag') ?? undefined, fetchedAt: now });
    return { data: data as T, source: 'live' };
  } catch (error) {
    if (existing && now - existing.fetchedAt <= MAX_STALE_MS) {
      return {
        data: existing.data,
        source: 'stale-cache',
        warning: `Canonical Catalog refresh failed; using version ${existing.data && (existing.data as { meta?: CatalogMeta }).meta?.catalog_version || 'unknown'} from memory for this process.`,
      };
    }
    throw error;
  }
}

function queryPath(path: string, values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function getCatalogModels(capability?: string, lifecycle?: string): Promise<CatalogResult<CatalogModelsResponse>> {
  return loadCatalog(queryPath('/v1/catalog/models', { capability, lifecycle }), 'list_models');
}

export function getCatalogPricing(modelId?: string): Promise<CatalogResult<CatalogPricingResponse>> {
  return loadCatalog(queryPath('/v1/catalog/pricing', { model_id: modelId }), 'estimate_cost');
}

export function getCatalogHealth(modelId?: string): Promise<CatalogResult<CatalogHealthResponse>> {
  return loadCatalog(queryPath('/v1/catalog/health', { model_id: modelId }), 'model_health');
}

export function getCatalogSetup(modelId: string): Promise<CatalogResult<CatalogSetupResponse>> {
  return loadCatalog(queryPath('/v1/catalog/setup', { client: 'mcp', model: modelId }), 'mcp_setup');
}

export async function resolveCatalogModel(modelId: string, capability: string): Promise<CatalogResult<CatalogModelsResponse> & { model: CatalogModel }> {
  const result = await getCatalogModels(capability, undefined);
  const requested = modelId.trim().toLowerCase();
  const model = result.data.models.find(value =>
    value.lifecycle !== 'retired' &&
    (value.model_id.toLowerCase() === requested || value.aliases.some(alias => alias.toLowerCase() === requested)),
  );
  if (!model) throw new CatalogModelUnavailableError(modelId, capability);
  return { ...result, model };
}

export function resetCatalogCacheForTests(): void {
  cache.clear();
}
