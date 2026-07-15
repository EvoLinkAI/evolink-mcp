import { randomUUID } from 'node:crypto';

export const DEFAULT_READ_TIMEOUT_MS = 15_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 120_000;
export const MAX_RETRY_DELAY_MS = 30_000;

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class PaidRequestOutcomeUnknownError extends Error {
  constructor(public readonly cause: unknown) {
    super('paid request outcome is unknown; do not retry automatically');
    this.name = 'PaidRequestOutcomeUnknownError';
  }
}

export function newRunId(): string {
  return `run_${randomUUID().replaceAll('-', '')}`;
}

export function timeoutFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error(`${name} must be an integer between 1000 and 600000 milliseconds`);
  }
  return parsed;
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
  }
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - nowMs), MAX_RETRY_DELAY_MS);
}

export function responseRequestId(headers: Headers): string | undefined {
  return headers.get('x-request-id')?.trim()
    || headers.get('x-oneapi-request-id')?.trim()
    || undefined;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RequestTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 2_000) };
  }
}
