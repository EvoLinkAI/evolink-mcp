import { processCredentialsAllowed } from '../request-context.js';
import { API_KEYS_URL, TOP_UP_URL, siteUrl } from './http-policy.js';

// --- HTTP-level errors (non-2xx gateway responses) ---

/**
 * What the assistant should do about a rejection. The gateway already tells
 * the three quota cases apart by error.code (all are HTTP 402 with the same
 * error.type), so classification goes by code first and status second.
 */
export type ErrorCategory =
  | 'account_balance_insufficient'
  | 'key_quota_exhausted'
  | 'key_daily_quota_exhausted'
  | 'key_disabled'
  | 'key_expired'
  | 'model_not_allowed'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid_request'
  | 'not_found'
  | 'content_policy'
  | 'model_unavailable'
  | 'idempotency_conflict'
  | 'outcome_unknown'
  | 'request_too_large'
  | 'server_error';

export interface GatewayErrorInfo {
  status: number;
  category: ErrorCategory;
  code?: string;
  message: string;
  next_step: string;
  retryable: boolean;
  retry_after_seconds?: number;
  action_url?: string;
  request_id?: string;
  /** Key name, balance and limit figures the gateway attaches to quota rejections (credits). */
  details?: Record<string, unknown>;
}

/** Gateway display rate: 1 USD = 6.8 CNY and 1 CNY = 10 credits. */
export const CREDITS_PER_USD = 68;

const ACCOUNT_CODES = new Set(['insufficient_quota', 'insufficient_user_quota', 'quota_not_enough', 'account_balance_insufficient']);
const KEY_QUOTA_CODES = new Set(['insufficient_token_quota', 'key_quota_exhausted']);
const KEY_DAILY_CODES = new Set(['token_daily_quota_exceeded', 'key_daily_quota_exhausted']);
const CONTENT_CODES = new Set(['content_policy_violation', 'content_filter', 'sensitive_content', 'moderation_blocked', 'input_moderation_failed']);
const UNAVAILABLE_CODES = new Set(['no_available_channel', 'model_unavailable', 'channel_selection_failed', 'service_unavailable']);

const DETAIL_FIELDS = [
  'key_name',
  'estimated_credits',
  'account_balance_credits',
  'total_limit_credits',
  'used_credits',
  'remaining_credits',
  'daily_limit_credits',
  'daily_used_credits',
  'reset_timezone',
  'allowed_models',
] as const;

interface ErrorEnvelope {
  code?: unknown;
  message?: unknown;
  type?: unknown;
  action_url?: unknown;
  request_id?: unknown;
  [key: string]: unknown;
}

function envelope(body: unknown): ErrorEnvelope {
  if (!body || typeof body !== 'object') return {};
  const record = body as Record<string, unknown>;
  if (record.error && typeof record.error === 'object') return record.error as ErrorEnvelope;
  // files-api: { success: false, code, msg }; OAuth-style: { error: "x", error_description: "…" }
  return {
    code: typeof record.error === 'string' ? record.error : record.code,
    message: record.msg ?? record.error_description ?? record.message,
  };
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function categorize(status: number, code: string): ErrorCategory {
  const lower = code.toLowerCase();
  if (ACCOUNT_CODES.has(lower)) return 'account_balance_insufficient';
  if (KEY_QUOTA_CODES.has(lower)) return 'key_quota_exhausted';
  if (KEY_DAILY_CODES.has(lower)) return 'key_daily_quota_exhausted';
  if (lower === 'key_disabled') return 'key_disabled';
  if (lower === 'key_expired') return 'key_expired';
  if (lower === 'key_model_not_allowed') return 'model_not_allowed';
  if (lower === 'idempotency_conflict') return 'idempotency_conflict';
  if (lower === 'paid_outcome_unknown') return 'outcome_unknown';
  if (CONTENT_CODES.has(lower)) return 'content_policy';
  if (UNAVAILABLE_CODES.has(lower) || lower.startsWith('channel:')) return 'model_unavailable';
  switch (status) {
    case 401: return 'unauthorized';
    case 402: return 'account_balance_insufficient';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 413: return 'request_too_large';
    case 429: return 'rate_limited';
    case 503: return 'model_unavailable';
  }
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}

const RETRYABLE: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'key_daily_quota_exhausted',
  'rate_limited',
  'model_unavailable',
  'outcome_unknown',
  'server_error',
]);

function credits(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return `${formatCredits(value)} credits (≈$${formatUsd(value / CREDITS_PER_USD)})`;
}

export function formatCredits(value: number): string {
  return Number(value.toFixed(4)).toString();
}

export function formatUsd(value: number): string {
  if (value === 0) return '0';
  if (Math.abs(value) >= 1) return value.toFixed(2);
  if (Math.abs(value) >= 0.01) return value.toFixed(3);
  return Number(value.toPrecision(2)).toString();
}

function nextStep(category: ErrorCategory, info: GatewayErrorInfo): string {
  const hosted = !processCredentialsAllowed();
  const details = info.details ?? {};
  const action = info.action_url;
  switch (category) {
    case 'account_balance_insufficient': {
      const balance = credits(details.account_balance_credits);
      const needed = credits(details.estimated_credits);
      const figures = [balance && `Balance: ${balance}.`, needed && `This request needs about ${needed}.`].filter(Boolean).join(' ');
      return `${figures ? `${figures} ` : ''}Ask the user to top up at ${action ?? TOP_UP_URL}, then retry.`;
    }
    case 'key_quota_exhausted':
      return hosted
        ? `This connection's spending limit is used up. Ask the user to raise or remove it in the EvoLink console (${action ?? API_KEYS_URL}).`
        : `This API key's total limit is used up. Raise it at ${action ?? API_KEYS_URL} or use another key.`;
    case 'key_daily_quota_exhausted': {
      const zone = text(details.reset_timezone);
      return `The daily limit is used up. It resets automatically at midnight${zone ? ` (${zone})` : ''}; to continue today, raise the daily limit at ${action ?? API_KEYS_URL}.`;
    }
    case 'key_disabled':
      return hosted
        ? 'This EvoLink connection was disabled. Ask the user to reconnect EvoLink in this client.'
        : `This API key is disabled. Enable it at ${action ?? API_KEYS_URL} or use another key.`;
    case 'key_expired':
      return hosted
        ? 'This EvoLink connection has expired. Ask the user to reconnect EvoLink in this client.'
        : `This API key has expired. Extend it at ${action ?? API_KEYS_URL} or use another key.`;
    case 'model_not_allowed': {
      const allowed = Array.isArray(details.allowed_models) ? details.allowed_models.slice(0, 20).join(', ') : '';
      return `This key may not use this model.${allowed ? ` Allowed models: ${allowed}.` : ''} Pick an allowed model, or change the key's model list at ${action ?? API_KEYS_URL}.`;
    }
    case 'unauthorized':
      return hosted
        ? 'The EvoLink connection was rejected. Ask the user to reconnect EvoLink in this client.'
        : 'The API key was rejected. Check EVOLINK_API_KEY, or run `evolink login` again.';
    case 'forbidden':
      return 'Access to this resource is denied for this account.';
    case 'rate_limited':
      return `Too many requests. Wait ${info.retry_after_seconds ?? 30} seconds before retrying; do not loop paid submissions.`;
    case 'invalid_request':
      return 'Fix the parameter named in the message and retry. get_model lists every parameter with its allowed values.';
    case 'not_found':
      return 'Nothing matches this ID. Check it, or use list_tasks to find recent tasks.';
    case 'content_policy':
      return 'The prompt or input was blocked by content review. Rephrase it (no real people, brands, explicit or violent content) and retry.';
    case 'model_unavailable':
      return 'The model is temporarily unavailable. Retry in a minute, or pick another model with search_models.';
    case 'idempotency_conflict':
      return 'This client_request_id was already used for a different request. Use a new client_request_id for a new generation.';
    case 'outcome_unknown':
      return 'The earlier submission with this client_request_id is still being processed or its outcome is unknown. Do not submit it again with a new id: wait a minute and retry with the same client_request_id, or look it up with list_tasks.';
    case 'request_too_large':
      return 'The request is too large. Upload big files with upload_file and pass the returned link instead.';
    case 'server_error':
      return 'EvoLink had a temporary error. Retry in a minute; for paid generations check list_tasks first so the task is not submitted twice.';
  }
}

/** Classifies one non-2xx gateway or files-api response. */
export function classifyGatewayError(
  status: number,
  body: unknown,
  retryAfterMs?: number,
  headerRequestId?: string,
): GatewayErrorInfo {
  const error = envelope(body);
  const code = text(error.code);
  const category = categorize(status, code ?? '');
  const requestId = text(error.request_id) ?? headerRequestId;
  const rawMessage = text(error.message) ?? `HTTP ${status}`;
  const message = rawMessage.replace(/\s*\(request id: [^)]*\)\s*$/i, '').slice(0, 600);

  const details: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) {
    if (error[field] !== undefined && error[field] !== null && error[field] !== '') details[field] = error[field];
  }

  const defaultAction = category === 'account_balance_insufficient'
    ? TOP_UP_URL
    : ['key_quota_exhausted', 'key_daily_quota_exhausted', 'key_disabled', 'key_expired', 'model_not_allowed'].includes(category)
      ? API_KEYS_URL
      : undefined;
  const info: GatewayErrorInfo = {
    status,
    category,
    code,
    message,
    next_step: '',
    retryable: RETRYABLE.has(category),
    retry_after_seconds: retryAfterMs !== undefined ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : undefined,
    action_url: defaultAction ? siteUrl(text(error.action_url), defaultAction) : undefined,
    request_id: requestId,
    details: Object.keys(details).length > 0 ? details : undefined,
  };
  info.next_step = nextStep(category, info);
  return info;
}

export function formatGatewayError(info: GatewayErrorInfo): string {
  const lines = [
    `[${info.status}${info.code ? ` ${info.code}` : ''}] ${info.message}`,
    `Next step: ${info.next_step}`,
  ];
  if (info.request_id) lines.push(`Request ID: ${info.request_id}`);
  return lines.join('\n');
}

export function formatApiError(status: number, body: unknown): string {
  return formatGatewayError(classifyGatewayError(status, body));
}

// --- Task-level errors (status "failed" in a task record) ---

export type TaskErrorCode =
  | 'content_policy_violation'
  | 'invalid_parameters'
  | 'image_dimension_mismatch'
  | 'image_processing_error'
  | 'request_cancelled'
  | 'resource_not_found'
  | 'generation_timeout'
  | 'quota_exceeded'
  | 'resource_exhausted'
  | 'generation_failed_no_content'
  | 'service_error'
  | 'service_unavailable'
  | 'unknown_error';

export interface TaskErrorInfo {
  suggestion: string;
  retryable: boolean;
}

const TASK_ERROR_MAP: Record<TaskErrorCode, TaskErrorInfo> = {
  content_policy_violation: {
    suggestion: 'Revise the prompt: avoid real person photos, celebrity names, copyrighted content, NSFW or violence. An illustration style often passes.',
    retryable: false,
  },
  invalid_parameters: {
    suggestion: 'Check the parameter values (prompt length, image size, duration, resolution) against get_model.',
    retryable: false,
  },
  image_dimension_mismatch: {
    suggestion: 'The input image does not match the requested aspect ratio. Resize it (for example 1280x720 for 16:9) or change the ratio.',
    retryable: false,
  },
  image_processing_error: {
    suggestion: 'The input image could not be processed. Use JPG, PNG or WebP under 10 MB at a publicly reachable URL (upload_file gives one).',
    retryable: false,
  },
  request_cancelled: {
    suggestion: 'The task was cancelled. Submit a new request if it was not intended.',
    retryable: false,
  },
  resource_not_found: {
    suggestion: 'The task or an input resource was not found or has expired. Check the IDs and links.',
    retryable: false,
  },
  generation_timeout: {
    suggestion: 'Generation timed out, probably under high load. Retry, or simplify the prompt or lower the resolution.',
    retryable: true,
  },
  quota_exceeded: {
    suggestion: `The account was over quota or rate limited when the task ran. Wait, then retry; top up at ${TOP_UP_URL} if the balance is low.`,
    retryable: true,
  },
  resource_exhausted: {
    suggestion: 'Provider capacity was temporarily exhausted. Wait 30–60 seconds and retry.',
    retryable: true,
  },
  generation_failed_no_content: {
    suggestion: 'The model produced no output, often because of protected content or watermark removal requests. Change the prompt or input and retry.',
    retryable: true,
  },
  service_error: {
    suggestion: 'Temporary service error. Retry after a minute.',
    retryable: true,
  },
  service_unavailable: {
    suggestion: 'The service was temporarily unavailable. Retry after 1–2 minutes.',
    retryable: true,
  },
  unknown_error: {
    suggestion: 'Unknown error. Retry after a minute; if it keeps failing, give the task ID to EvoLink support.',
    retryable: true,
  },
};

export function getTaskErrorInfo(code: string): TaskErrorInfo {
  return TASK_ERROR_MAP[code as TaskErrorCode] ?? TASK_ERROR_MAP.unknown_error;
}

export function formatTaskError(error: { code?: string; message?: string }): string {
  const code = error.code ?? 'unknown_error';
  const info = getTaskErrorInfo(code);
  const lines: string[] = [
    `Error code: ${code}`,
    `Message: ${error.message ?? 'No details provided'}`,
    `Retryable: ${info.retryable ? 'Yes — you can retry this request' : 'No — modify your input before retrying'}`,
    `Suggestion: ${info.suggestion}`,
  ];
  return lines.join('\n');
}
