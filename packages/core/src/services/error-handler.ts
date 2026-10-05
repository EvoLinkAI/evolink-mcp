import { currentCredentialMode, type CredentialMode } from '../request-context.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, TOP_UP_URL, siteUrl } from './http-policy.js';

// --- HTTP-level errors (non-2xx gateway responses) ---

/**
 * What the assistant should do about a rejection. The gateway already tells
 * the three quota cases apart by error.code (all are HTTP 402 with the same
 * error.type), so classification goes by code first and status second.
 *
 * A signed-in connection spends the account's internal MCP key, so its key
 * limits are the user's "EvoLink MCP limit" (mcp_*), never an API key's.
 */
export type ErrorCategory =
  | 'account_balance_insufficient'
  | 'mcp_limit_reached'
  | 'mcp_daily_limit_reached'
  | 'mcp_paused'
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
  | 'server_error'
  | 'connection_ended'
  | 'session_check_unavailable'
  | 'connection_setup_failed'
  | 'service_misconfigured'
  | 'account_disabled';

export interface GatewayErrorInfo {
  status: number;
  category: ErrorCategory;
  /**
   * First sentence for the user when a limit, the balance or the connection
   * stopped the request. It names which one, so every client can tell an
   * EvoLink MCP limit from an empty account.
   */
  headline?: string;
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
/** Hosted service channel (key custody A): the connection itself is gone and needs a new sign-in. */
const CONNECTION_ENDED_CODES = new Set(['connection_not_found', 'connection_revoked', 'session_inactive', 'session_expired']);
/** The hosted service, not the user's connection, was refused or sent an incomplete request. */
const SERVICE_CODES = new Set(['mcp_service_unauthorized', 'mcp_connection_required']);

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

/**
 * @param mcpLimits the key limits are the account's EvoLink MCP limit: a
 *   signed-in connection, or the gateway said so with limit_scope "mcp".
 */
function categorize(status: number, code: string, mode: CredentialMode, mcpLimits: boolean): ErrorCategory {
  const lower = code.toLowerCase();
  if (ACCOUNT_CODES.has(lower)) return 'account_balance_insufficient';
  if (KEY_QUOTA_CODES.has(lower)) return mcpLimits ? 'mcp_limit_reached' : 'key_quota_exhausted';
  if (KEY_DAILY_CODES.has(lower)) return mcpLimits ? 'mcp_daily_limit_reached' : 'key_daily_quota_exhausted';
  if (lower === 'mcp_paused') return 'mcp_paused';
  // The account's MCP key is only ever disabled by "pause all" in the console.
  if (lower === 'key_disabled') return mode === 'signed_in' ? 'mcp_paused' : 'key_disabled';
  if (lower === 'key_expired') return 'key_expired';
  if (lower === 'key_model_not_allowed') return 'model_not_allowed';
  if (lower === 'idempotency_conflict') return 'idempotency_conflict';
  if (lower === 'paid_outcome_unknown') return 'outcome_unknown';
  if (CONTENT_CODES.has(lower)) return 'content_policy';
  if (UNAVAILABLE_CODES.has(lower) || lower.startsWith('channel:')) return 'model_unavailable';
  if (CONNECTION_ENDED_CODES.has(lower)) return 'connection_ended';
  if (lower === 'agent_session_unavailable') return 'session_check_unavailable';
  if (lower === 'mcp_connection_create_failed') return 'connection_setup_failed';
  if (SERVICE_CODES.has(lower)) return 'service_misconfigured';
  if (lower === 'user_disabled') return 'account_disabled';
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
  'mcp_daily_limit_reached',
  'rate_limited',
  'model_unavailable',
  'outcome_unknown',
  'server_error',
  'session_check_unavailable',
  'connection_setup_failed',
]);

/** Answers about the account's EvoLink MCP limit; their console link is the MCP settings, not API Keys. */
const MCP_LIMIT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>(['mcp_limit_reached', 'mcp_daily_limit_reached', 'mcp_paused']);
const KEY_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'key_quota_exhausted', 'key_daily_quota_exhausted', 'key_disabled', 'key_expired', 'model_not_allowed',
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

/** Sentences naming which limit stopped the request; the same words in every client. */
function headlineFor(category: ErrorCategory): string | undefined {
  switch (category) {
    case 'mcp_limit_reached':
      return 'EvoLink MCP spending limit reached. This is the limit set for MCP, not your account balance.';
    case 'mcp_daily_limit_reached':
      return 'EvoLink MCP daily limit reached. It resets at midnight; this is not your account balance.';
    case 'mcp_paused':
      return 'EvoLink MCP is paused for this account. Resume it in the console; you do not need to reconnect.';
    case 'account_balance_insufficient':
      return 'Your EvoLink account balance is too low for this request. The balance is shared by API, web and MCP.';
    case 'key_quota_exhausted':
      return 'This API key\'s spending limit is used up. This is the key\'s own limit, not your account balance.';
    case 'key_daily_quota_exhausted':
      return 'This API key\'s daily limit is used up. It resets at midnight; this is not your account balance.';
    case 'connection_ended':
      return 'This EvoLink connection was disconnected. Reconnect EvoLink in this client.';
    default:
      return undefined;
  }
}

/** "Limit: …; used: …; left: …." from whatever figures the gateway attached. */
function limitFigures(details: Record<string, unknown>, label: string): string {
  const parts = [
    credits(details.total_limit_credits) && `${label}: ${credits(details.total_limit_credits)}`,
    credits(details.used_credits) && `used: ${credits(details.used_credits)}`,
    credits(details.remaining_credits) && `left: ${credits(details.remaining_credits)}`,
  ].filter(Boolean);
  return parts.length ? `${parts.join('; ')}.` : '';
}

function sentences(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

function nextStep(category: ErrorCategory, info: GatewayErrorInfo, mode: CredentialMode): string {
  const details = info.details ?? {};
  const action = info.action_url;
  const needed = credits(details.estimated_credits);
  const balance = credits(details.account_balance_credits);
  const zone = text(details.reset_timezone);
  switch (category) {
    case 'account_balance_insufficient':
      return sentences(
        balance && `Balance: ${balance}.`,
        needed && `This request needs about ${needed}.`,
        `Ask the user to top up at ${action ?? TOP_UP_URL}, then retry.`,
      );
    case 'mcp_limit_reached':
      return sentences(
        limitFigures(details, 'EvoLink MCP limit'),
        needed && `This request needs about ${needed}.`,
        balance && `Account balance: ${balance} (not the problem).`,
        `Ask the user to raise or remove the EvoLink MCP limit at ${action ?? MCP_CONSOLE_URL}; it is shared by every assistant connected to their EvoLink account.`,
        'Do not retry until they have changed it.',
      );
    case 'mcp_daily_limit_reached': {
      const used = credits(details.daily_used_credits);
      const limit = credits(details.daily_limit_credits);
      return sentences(
        used && limit && `Today's EvoLink MCP spending: ${used} of the ${limit} daily limit.`,
        `It resets automatically at midnight${zone ? ` (${zone})` : ''}.`,
        balance && `Account balance: ${balance} (not the problem).`,
        `To continue today, ask the user to raise the EvoLink MCP daily limit at ${action ?? MCP_CONSOLE_URL}.`,
      );
    }
    case 'mcp_paused':
      return `Ask the user to resume EvoLink MCP at ${action ?? MCP_CONSOLE_URL}. Do not ask them to reconnect, and do not retry until it is resumed.`;
    case 'key_quota_exhausted': {
      const name = text(details.key_name);
      return sentences(
        limitFigures(details, name ? `Limit of API key "${name}"` : 'API key limit'),
        needed && `This request needs about ${needed}.`,
        balance && `Account balance: ${balance} (not the problem).`,
        `Raise this API key's limit at ${action ?? API_KEYS_URL}, or use another key.`,
      );
    }
    case 'key_daily_quota_exhausted':
      return `It resets automatically at midnight${zone ? ` (${zone})` : ''}; to continue today, raise this API key's daily limit at ${action ?? API_KEYS_URL}.`;
    case 'key_disabled':
      return `This API key is disabled. Enable it at ${action ?? API_KEYS_URL} or use another key.`;
    case 'key_expired':
      return mode === 'signed_in'
        ? 'This EvoLink connection has expired. Ask the user to reconnect EvoLink in this client.'
        : `This API key has expired. Extend it at ${action ?? API_KEYS_URL} or use another key.`;
    case 'model_not_allowed': {
      const allowed = Array.isArray(details.allowed_models) ? details.allowed_models.slice(0, 20).join(', ') : '';
      return `This key may not use this model.${allowed ? ` Allowed models: ${allowed}.` : ''} Pick an allowed model, or change the key's model list at ${action ?? API_KEYS_URL}.`;
    }
    case 'unauthorized':
      if (mode === 'signed_in') return 'The EvoLink connection was rejected. Ask the user to reconnect EvoLink in this client.';
      return mode === 'api_key'
        ? 'The API key was rejected. Ask the user to check the EvoLink API key configured in this client.'
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
      return 'The request is too large. Pass big files as links (a public URL, or one from upload_file where it is available) instead of inline data.';
    case 'server_error':
      return 'EvoLink had a temporary error. Retry in a minute; for paid generations check list_tasks first so the task is not submitted twice.';
    case 'connection_ended':
      return 'This EvoLink connection is no longer active (it was revoked, expired, or signed out). Ask the user to reconnect the existing EvoLink connection in this client instead of adding a new one.';
    case 'session_check_unavailable':
      return 'EvoLink sign-in verification is temporarily unavailable. Retry in a minute; do not reconnect.';
    case 'connection_setup_failed':
      return 'EvoLink could not set up this connection yet. Retry in a minute.';
    case 'service_misconfigured':
      return 'The EvoLink MCP service could not authenticate this request. This is a server-side problem, not the user\'s connection: do not reconnect, and try again later.';
    case 'account_disabled':
      return 'This EvoLink account is disabled. Ask the user to contact EvoLink support.';
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
  const mode = currentCredentialMode();
  const mcpScope = text(error.limit_scope)?.toLowerCase() === 'mcp';
  const category = categorize(status, code ?? '', mode, mcpScope || mode === 'signed_in');
  const requestId = text(error.request_id) ?? headerRequestId;
  const rawMessage = text(error.message) ?? `HTTP ${status}`;
  const message = rawMessage.replace(/\s*\(request id: [^)]*\)\s*$/i, '').slice(0, 600);

  const details: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) {
    if (error[field] !== undefined && error[field] !== null && error[field] !== '') details[field] = error[field];
  }

  let actionUrl: string | undefined;
  if (category === 'account_balance_insufficient') {
    actionUrl = siteUrl(text(error.action_url), TOP_UP_URL);
  } else if (MCP_LIMIT_CATEGORIES.has(category)) {
    // Until the gateway marks the answer as an MCP limit, its link is the API Keys page, where this key is not listed.
    const gatewayKnows = mcpScope || code?.toLowerCase() === 'mcp_paused';
    actionUrl = gatewayKnows ? siteUrl(text(error.action_url), MCP_CONSOLE_URL) : MCP_CONSOLE_URL;
  } else if (KEY_CATEGORIES.has(category)) {
    actionUrl = siteUrl(text(error.action_url), API_KEYS_URL);
  }
  const headline = headlineFor(category);
  const info: GatewayErrorInfo = {
    status,
    category,
    ...(headline ? { headline } : {}),
    code,
    message,
    next_step: '',
    retryable: RETRYABLE.has(category),
    retry_after_seconds: retryAfterMs !== undefined ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : undefined,
    action_url: actionUrl,
    request_id: requestId,
    details: Object.keys(details).length > 0 ? details : undefined,
  };
  info.next_step = nextStep(category, info, mode);
  return info;
}

/**
 * With a headline the first line says which limit it is; the gateway's own
 * sentence is left out because it speaks of "API key …" even for the MCP key.
 */
export function formatGatewayError(info: GatewayErrorInfo): string {
  const status = `${info.status}${info.code ? ` ${info.code}` : ''}`;
  const lines = info.headline
    ? [info.headline, `Next step: ${info.next_step}`, `Error: HTTP ${status}`]
    : [`[${status}] ${info.message}`, `Next step: ${info.next_step}`];
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
