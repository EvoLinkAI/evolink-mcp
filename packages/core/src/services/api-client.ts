import { type ServerConfig, getApiKey } from '../config.js';
import { classifyGatewayError, formatGatewayError, type GatewayErrorInfo } from './error-handler.js';
import {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_SUBMIT_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
  PaidRequestOutcomeUnknownError,
  RequestTimeoutError,
  evoHeaders,
  fetchWithTimeout,
  newRunId,
  parseRetryAfter,
  readJsonBody,
  responseRequestId,
  timeoutFromEnv,
} from './http-policy.js';

// --- Types ---

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  tool?: string;
  timeoutMs?: number;
}

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface TaskResponse {
  created: number;
  id: string;
  model: string;
  object: string;
  progress: number;
  status: TaskStatus;
  type: string;
  duration?: number;
  video_duration?: number;
  results?: string[];
  result_data?: ResultDataItem[] | Record<string, unknown>;
  task_info?: {
    can_cancel?: boolean;
    estimated_time?: number;
    video_duration?: number;
  };
  usage?: {
    billing_rule?: string;
    credits_reserved?: number;
    credits_used?: number;
    cost?: { credits?: number; usd?: number; cny?: number };
    user_group?: string;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
    suggestion?: string;
  };
  request_id?: string;
  /** Set by the MCP client when the gateway answered a repeated Idempotency-Key with the original response. */
  idempotency_replayed?: boolean;
}

export interface ResultDataItem {
  result_id?: string;
  duration?: number;
  tags?: string;
  title?: string;
  image_url?: string;
  audio_url?: string;
  stream_audio_url?: string;
  video_url?: string;
}

export interface TaskListItem {
  id: string;
  model: string;
  type: string;
  status: TaskStatus;
  progress: number;
  created_at: number;
  duration?: number;
  has_results?: boolean;
  result_count?: number;
  has_error?: boolean;
  credits_used?: number;
}

export interface TaskListResponse {
  data: TaskListItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface CreditsResponse {
  user: { remaining_credits: number; used_credits: number };
  token: { remaining_credits: number; used_credits: number; unlimited_credits: boolean };
}

// --- Error class for HTTP-level failures ---

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly requestId?: string,
    public readonly info?: GatewayErrorInfo,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

// --- Retry logic ---

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  // Key and balance rejections are always HTTP 402, so they are never retried here.
  if (error instanceof ApiHttpError) return RETRYABLE_STATUS_CODES.has(error.status);
  if (error instanceof PaidRequestOutcomeUnknownError) return true;
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof TypeError) return true; // network errors (DNS, reset, …)
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries && isRetryable(error)) {
        const retryAfterMs = error instanceof ApiHttpError ? error.retryAfterMs : undefined;
        await sleep(Math.min(retryAfterMs ?? baseDelayMs * (attempt + 1), MAX_RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

// --- Core request (no retry) ---

async function rawRequest<T>(config: ServerConfig, options: RequestOptions): Promise<{ data: T; requestId?: string; headers: Headers }> {
  const url = `${config.baseUrl}${options.path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${getApiKey()}`,
    'Accept': 'application/json',
    ...evoHeaders(options.tool ?? 'unknown'),
  };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
    headers['X-Evo-Run-Id'] = options.idempotencyKey;
  }

  const isRead = options.method === 'GET' || !options.idempotencyKey;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }, options.timeoutMs ?? timeoutFromEnv(
      isRead ? 'EVOLINK_MCP_READ_TIMEOUT_MS' : 'EVOLINK_MCP_WRITE_TIMEOUT_MS',
      isRead ? DEFAULT_READ_TIMEOUT_MS : DEFAULT_SUBMIT_TIMEOUT_MS,
    ));
  } catch (error) {
    if (!isRead) throw new PaidRequestOutcomeUnknownError(error, options.idempotencyKey);
    throw error;
  }

  const data = await readJsonBody(response);
  const requestId = responseRequestId(response.headers);

  if (!response.ok) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    const info = classifyGatewayError(response.status, data, retryAfterMs, requestId);
    throw new ApiHttpError(response.status, formatGatewayError(info), retryAfterMs, info.request_id, info);
  }
  return { data: data as T, requestId, headers: response.headers };
}

// --- Public API ---

export interface SubmitOptions {
  path: string;
  body: Record<string, unknown>;
  tool: string;
  /** Reused on a retry of the same intent; a fresh one is generated when absent. */
  idempotencyKey?: string;
}

/**
 * Submit one paid intent. At most one transport retry, always with the same
 * idempotency key, so the gateway ledger (Idempotency-Key) can return the
 * original task instead of creating a second one.
 */
export async function submitTask(config: ServerConfig, options: SubmitOptions): Promise<TaskResponse> {
  const idempotencyKey = options.idempotencyKey ?? newRunId();
  const { data, requestId, headers } = await withRetry(
    () => rawRequest<TaskResponse>(config, {
      method: 'POST',
      path: options.path,
      body: options.body,
      tool: options.tool,
      idempotencyKey,
    }),
    1,
    500,
  );
  if (!data.request_id && requestId) data.request_id = requestId;
  if (headers.get('idempotency-replayed') === 'true') data.idempotency_replayed = true;
  return data;
}

/** @deprecated kept for callers outside the tools; use submitTask. */
export async function apiRequest(
  config: ServerConfig,
  options: { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; tool?: string },
): Promise<TaskResponse> {
  if (options.method !== 'POST' || !options.body) {
    throw new Error('apiRequest only accepts generation POST operations');
  }
  return submitTask(config, { path: options.path, body: options.body, tool: options.tool ?? 'unknown' });
}

/** One task (GET /v1/tasks/{id}). Unfinished tasks sync with the provider on every read, so callers pace themselves. */
export async function queryTask(config: ServerConfig, taskId: string, tool = 'get_task'): Promise<TaskResponse> {
  const { data, requestId } = await withRetry(
    () => rawRequest<TaskResponse>(config, { method: 'GET', path: `/v1/tasks/${encodeURIComponent(taskId)}`, tool }),
    2,
    1500,
  );
  if (!data.request_id && requestId) data.request_id = requestId;
  return data;
}

/** Up to 50 tasks in one call (POST /v1/tasks/batch); unknown or foreign IDs are simply absent. */
export async function queryTasks(config: ServerConfig, taskIds: string[], tool = 'list_tasks'): Promise<TaskResponse[]> {
  const { data } = await withRetry(
    () => rawRequest<{ data?: TaskResponse[] }>(config, {
      method: 'POST',
      path: '/v1/tasks/batch',
      body: { task_ids: taskIds },
      tool,
    }),
    2,
    1500,
  );
  return Array.isArray(data.data) ? data.data : [];
}

export interface ListTasksQuery {
  status?: string;
  type?: string;
  model?: string;
  page?: number;
  pageSize?: number;
}

/** The account's recent tasks, newest first (GET /v1/tasks). Items carry no result links. */
export async function listTasks(config: ServerConfig, query: ListTasksQuery, tool = 'list_tasks'): Promise<TaskListResponse> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.type) params.set('type', query.type);
  if (query.model) params.set('model', query.model);
  params.set('page', String(query.page ?? 1));
  params.set('page_size', String(query.pageSize ?? 20));
  const { data } = await withRetry(
    () => rawRequest<Partial<TaskListResponse>>(config, { method: 'GET', path: `/v1/tasks?${params}`, tool }),
    2,
    1500,
  );
  return {
    data: Array.isArray(data.data) ? data.data : [],
    total: typeof data.total === 'number' ? data.total : 0,
    page: typeof data.page === 'number' ? data.page : query.page ?? 1,
    page_size: typeof data.page_size === 'number' ? data.page_size : query.pageSize ?? 20,
  };
}

/** Account balance and this key's usage (GET /v1/credits). */
export async function getCredits(config: ServerConfig, tool = 'check_balance'): Promise<CreditsResponse> {
  const { data, requestId } = await withRetry(
    () => rawRequest<{ success?: boolean; message?: string; data?: CreditsResponse }>(config, { method: 'GET', path: '/v1/credits', tool }),
    2,
    1000,
  );
  if (data.success === false || !data.data?.user || !data.data?.token) {
    const info = classifyGatewayError(500, { error: { message: data.message || 'The balance could not be read.' } }, undefined, requestId);
    throw new ApiHttpError(500, formatGatewayError(info), undefined, requestId, info);
  }
  return data.data;
}
