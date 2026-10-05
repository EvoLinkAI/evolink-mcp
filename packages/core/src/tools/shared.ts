import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { processCredentialsAllowed } from '../request-context.js';
import { ApiHttpError } from '../services/api-client.js';
import { CREDITS_PER_USD, formatCredits, formatUsd, type GatewayErrorInfo } from '../services/error-handler.js';
import { PaidRequestOutcomeUnknownError, RequestTimeoutError } from '../services/http-policy.js';

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Free lookups: clients can run them without asking. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Spends the user's balance and cannot be undone: clients ask before running it. */
export const PAID = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
/** Changes stored state without spending money (uploads). */
export const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** Text and structured content carry the same facts: some clients show the model only one of them. */
export function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { ok: true, ...structured } };
}

export function failure(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { ok: false, ...structured }, isError: true };
}

export function money(credits: number | undefined): string | undefined {
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return undefined;
  return `${formatCredits(credits)} credits (≈$${formatUsd(credits / CREDITS_PER_USD)})`;
}

export function usdOf(credits: number | undefined): number | undefined {
  if (typeof credits !== 'number' || !Number.isFinite(credits)) return undefined;
  return Number((credits / CREDITS_PER_USD).toFixed(6));
}

export interface ErrorContext {
  /** The call may have created a paid task. */
  paid?: boolean;
  /** Idempotency key the paid call used; repeating it cannot create a second task once the gateway ledger is live. */
  clientRequestId?: string;
}

function infoFor(error: unknown): GatewayErrorInfo {
  if (error instanceof ApiHttpError && error.info) return error.info;
  if (error instanceof ApiHttpError) {
    return { status: error.status, category: 'server_error', message: error.message, next_step: 'Retry in a minute.', retryable: true, request_id: error.requestId };
  }
  if (error instanceof PaidRequestOutcomeUnknownError) {
    return {
      status: 0,
      category: 'outcome_unknown',
      message: 'The submission timed out or the connection dropped, so it is unknown whether a task was created.',
      next_step: 'Do not submit again with a new client_request_id. Look for the task with list_tasks (status processing), or retry with the same client_request_id.',
      retryable: true,
    };
  }
  if (error instanceof RequestTimeoutError || error instanceof TypeError) {
    return { status: 0, category: 'server_error', message: 'EvoLink did not respond in time.', next_step: 'Retry in a minute.', retryable: true };
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  // Credential problems surface as plain errors from getApiKey() or the hosted key lookup.
  return {
    status: 0,
    category: 'unauthorized',
    message,
    next_step: processCredentialsAllowed()
      ? 'Set EVOLINK_API_KEY (create a key at https://evolink.ai/dashboard/keys), or run `evolink login`.'
      : 'Ask the user to reconnect EvoLink in this client. If it keeps failing, retry in a few minutes.',
    retryable: false,
  };
}

/** Converts a thrown error into a tool error with a category and a concrete next step. */
export function errorResult(error: unknown, context: ErrorContext = {}): CallToolResult {
  const info = infoFor(error);
  const lines = [`Error (${info.category}${info.code ? `, ${info.code}` : ''}${info.status ? `, HTTP ${info.status}` : ''}): ${info.message}`];
  lines.push(`Next step: ${info.next_step}`);
  let charged: 'no' | 'unknown' | undefined;
  if (context.paid) {
    if (info.category === 'outcome_unknown' || info.category === 'server_error') {
      charged = 'unknown';
      lines.push(context.clientRequestId
        ? `It is unclear whether a task was created. To retry this exact request safely, pass client_request_id "${context.clientRequestId}".`
        : 'It is unclear whether a task was created; check list_tasks before submitting again.');
    } else {
      charged = 'no';
      lines.push('Nothing was submitted or charged.');
    }
  }
  if (info.request_id) lines.push(`Request ID: ${info.request_id}`);
  return failure(lines.join('\n'), {
    error: info,
    ...(charged ? { charged } : {}),
    ...(context.clientRequestId && charged === 'unknown' ? { client_request_id: context.clientRequestId } : {}),
  });
}

/** Sends a progress notification when the client asked for them; failures are ignored. */
export function progressReporter(extra: ToolExtra | undefined, totalSeconds: number): (elapsedSeconds: number, message: string) => Promise<void> {
  const token = extra?._meta?.progressToken;
  let last = -1;
  return async (elapsedSeconds, message) => {
    if (token === undefined || !extra) return;
    const progress = Math.max(last + 1, Math.round(elapsedSeconds));
    last = progress;
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken: token, progress, total: Math.max(totalSeconds, progress), message },
    }).catch(() => undefined);
  };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
