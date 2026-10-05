import type { ServerConfig } from '../config.js';
import { queryTask, type ResultDataItem, type TaskResponse } from '../services/api-client.js';
import { getTaskErrorInfo } from '../services/error-handler.js';
import { money, sleep, usdOf } from './shared.js';

/** Result links from the gateway stay downloadable for this long. */
export const RESULT_LINK_HOURS = 24;

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface TaskResultLink {
  url: string;
  kind: 'image' | 'video' | 'audio' | 'file';
}

function kindOfUrl(url: string, taskType: string): TaskResultLink['kind'] {
  const path = url.split('?')[0].toLowerCase();
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(path)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/.test(path)) return 'video';
  if (/\.(mp3|wav|m4a|flac|ogg|aac)$/.test(path)) return 'audio';
  if (taskType.includes('image')) return 'image';
  if (taskType.includes('video')) return 'video';
  if (taskType.includes('audio') || taskType.includes('music')) return 'audio';
  return 'file';
}

export function resultLinks(task: TaskResponse): TaskResultLink[] {
  const seen = new Set<string>();
  const links: TaskResultLink[] = [];
  const add = (url: unknown, kind?: TaskResultLink['kind']) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || seen.has(url)) return;
    seen.add(url);
    links.push({ url, kind: kind ?? kindOfUrl(url, task.type ?? '') });
  };
  for (const url of task.results ?? []) add(url);
  if (Array.isArray(task.result_data)) {
    for (const item of task.result_data as ResultDataItem[]) {
      add(item.video_url, 'video');
      add(item.image_url, 'image');
      add(item.audio_url, 'audio');
    }
  }
  return links;
}

export interface TaskView {
  lines: string[];
  structured: Record<string, unknown>;
}

/** One task as text lines and the same facts as structured content. */
export function describeTask(task: TaskResponse): TaskView {
  const status = task.status ?? 'pending';
  const links = resultLinks(task);
  const lines = [
    `Task ${task.id}: ${status}${status === 'completed' || status === 'failed' ? '' : ` (${task.progress ?? 0}%)`}`,
    `Model: ${task.model}`,
  ];
  const structured: Record<string, unknown> = {
    task_id: task.id,
    status,
    progress: task.progress ?? 0,
    model: task.model,
    type: task.type,
  };

  if (links.length > 0) {
    lines.push(`Results (download links expire after ${RESULT_LINK_HOURS} hours; save them now):`);
    for (const link of links) lines.push(`- ${link.kind}: ${link.url}`);
    structured.results = links;
    structured.links_expire_after_hours = RESULT_LINK_HOURS;
  }

  const used = task.usage?.credits_used ?? task.usage?.cost?.credits;
  if (status === 'completed' && typeof used === 'number') {
    lines.push(`Charged: ${money(used)}`);
    structured.charged_credits = used;
    structured.charged_usd = task.usage?.cost?.usd ?? usdOf(used);
  }
  const reserved = task.usage?.credits_reserved;
  if (status !== 'completed' && status !== 'failed' && typeof reserved === 'number' && reserved > 0) {
    lines.push(`Reserved: ${money(reserved)} (the final charge is settled when the task finishes)`);
    structured.reserved_credits = reserved;
    structured.reserved_usd = usdOf(reserved);
  }
  if (typeof task.duration === 'number' && task.duration > 0 && TERMINAL_STATUSES.has(status)) {
    lines.push(`Took: ${task.duration} s`);
    structured.took_seconds = task.duration;
  }

  if (status === 'failed' || status === 'cancelled') {
    const code = task.error?.code ?? (status === 'cancelled' ? 'request_cancelled' : 'unknown_error');
    const info = getTaskErrorInfo(code);
    const suggestion = task.error?.suggestion ? `${info.suggestion} ${task.error.suggestion}` : info.suggestion;
    lines.push(`Error: ${code}${task.error?.message ? ` — ${task.error.message}` : ''}`);
    lines.push('Charge: failed tasks are refunded.');
    lines.push(`Next step: ${info.retryable ? 'You can retry with a new generate call.' : 'Change the input before retrying.'} ${suggestion}`);
    structured.error = { code, message: task.error?.message, retryable: info.retryable, suggestion };
    structured.refunded = true;
  } else if (status === 'completed') {
    lines.push('Next step: give the result links to the user.');
  } else {
    const eta = task.task_info?.estimated_time;
    if (eta) {
      lines.push(`Estimated time left: ~${eta} s`);
      structured.estimated_seconds = eta;
    }
    lines.push(`Next step: call get_task with task_id "${task.id}" again (it can wait up to 45 s). Do not call generate again to check progress: that starts and charges a new task.`);
  }
  if (task.request_id) {
    lines.push(`Request ID: ${task.request_id}`);
    structured.request_id = task.request_id;
  }
  return { lines, structured };
}

let pollIntervalOverrideMs: number | undefined;

/** Tests only: shorten the pause between task reads. */
export function setPollIntervalForTests(ms: number | undefined): void {
  pollIntervalOverrideMs = ms;
}

/** Pause between task reads: each read of an unfinished task makes the gateway ask the provider. */
export function pollIntervalMs(type: string | undefined): number {
  if (pollIntervalOverrideMs !== undefined) return pollIntervalOverrideMs;
  if (type?.includes('video')) return 8_000;
  if (type?.includes('audio') || type?.includes('music')) return 6_000;
  return 3_000;
}

export interface WaitOptions {
  /** Absolute time (ms) by which to return, finished or not. */
  deadline: number;
  tool: string;
  signal?: AbortSignal;
  onPoll?: (task: TaskResponse) => Promise<void>;
  /** A task already read by the caller; the first read is skipped when given. */
  initial?: TaskResponse;
}

/** Reads a task until it finishes or the deadline passes, pacing reads by task type. */
export async function waitForTask(config: ServerConfig, taskId: string, options: WaitOptions): Promise<TaskResponse> {
  let task = options.initial ?? await queryTask(config, taskId, options.tool);
  while (!TERMINAL_STATUSES.has(task.status) && !options.signal?.aborted) {
    const interval = pollIntervalMs(task.type);
    if (Date.now() + interval > options.deadline) break;
    await options.onPoll?.(task);
    await sleep(interval, options.signal);
    if (options.signal?.aborted) break;
    task = await queryTask(config, taskId, options.tool);
  }
  return task;
}
