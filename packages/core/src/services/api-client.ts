import { type ServerConfig, getApiKey } from '../config.js';
import { formatApiError } from './error-handler.js';
import {
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  MAX_RETRY_DELAY_MS,
  PaidRequestOutcomeUnknownError,
  RequestTimeoutError,
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
}

export interface TaskResponse {
  created: number;
  id: string;
  model: string;
  object: string;
  progress: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  type: string;
  results?: string[];
  result_data?: ResultDataItem[];
  task_info?: {
    can_cancel?: boolean;
    estimated_time?: number;
    video_duration?: number;
  };
  usage?: {
    billing_rule: string;
    credits_reserved: number;
    user_group: string;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
  request_id?: string;
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

// --- Error class for HTTP-level failures ---

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterMs?: number,
    public readonly requestId?: string,
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
  if (error instanceof ApiHttpError) return RETRYABLE_STATUS_CODES.has(error.status);
  if (error instanceof RequestTimeoutError) return true;
  if (error instanceof TypeError) return true; // network errors (DNS, timeout, etc.)
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

async function rawRequest(
  config: ServerConfig,
  options: RequestOptions,
): Promise<TaskResponse> {
  const url = `${config.baseUrl}${options.path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${getApiKey()}`,
    'Content-Type': 'application/json',
    'X-Evo-Client': 'mcp',
    'X-Evo-Client-Version': process.env.npm_package_version ?? 'dev',
    'X-Evo-Tool': options.tool ?? 'unknown',
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
    headers['X-Evo-Run-Id'] = options.idempotencyKey;
  }

  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    }, timeoutFromEnv(
      options.method === 'GET' ? 'EVOLINK_MCP_READ_TIMEOUT_MS' : 'EVOLINK_MCP_WRITE_TIMEOUT_MS',
      options.method === 'GET' ? DEFAULT_READ_TIMEOUT_MS : DEFAULT_WRITE_TIMEOUT_MS,
    ));
  } catch (error) {
    if (options.method === 'POST') throw new PaidRequestOutcomeUnknownError(error);
    throw error;
  }

  const data = await readJsonBody(response);
  const requestId = responseRequestId(response.headers);

  if (!response.ok) {
    throw new ApiHttpError(
      response.status,
      formatApiError(response.status, data),
      parseRetryAfter(response.headers.get('retry-after')),
      requestId,
    );
  }

  const task = data as TaskResponse;
  if (!task.request_id && requestId) task.request_id = requestId;
  return task;
}

// --- Public API ---

/** Submit exactly one generation POST. This client never retries a paid write. */
export async function apiRequest(
  config: ServerConfig,
  options: RequestOptions,
): Promise<TaskResponse> {
  if (options.method !== 'POST') {
    throw new Error('apiRequest only accepts generation POST operations');
  }
  return rawRequest(config, { ...options, idempotencyKey: newRunId() });
}

/** Query task status (GET). Retries up to 3 times for robust polling. */
export async function queryTask(
  config: ServerConfig,
  taskId: string,
): Promise<TaskResponse> {
  return withRetry(
    () => rawRequest(config, { method: 'GET', path: `/v1/tasks/${taskId}`, tool: 'check_task' }),
    3,
    1500,
  );
}

export function formatUsageInfo(usage?: TaskResponse['usage']): string {
  if (!usage?.credits_reserved) return '';
  return `Estimated cost: ${usage.credits_reserved} credits (${usage.billing_rule ?? 'standard'})`;
}
