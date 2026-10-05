import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { listTasks, queryTasks, type TaskResponse } from '../services/api-client.js';
import { READ_ONLY, errorResult, failure, money, ok, usdOf } from './shared.js';
import { TASK_ID } from './get-task.js';
import { RESULT_LINK_HOURS, resultLinks } from './task-format.js';

const MAX_IDS = 50;

/** ISO 8601, unix seconds, or relative such as 30m, 2h, 1d. */
export function parseSince(value: string, now = Date.now()): number | undefined {
  const trimmed = value.trim();
  const relative = /^(\d+)\s*(m|min|mins|minutes?|h|hours?|d|days?)$/i.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2][0].toLowerCase();
    const factor = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return now - amount * factor;
  }
  if (/^\d{9,11}$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface Row {
  task_id: string;
  status: string;
  model: string;
  type?: string;
  progress?: number;
  created_at?: string;
  results?: Array<{ url: string; kind: string }>;
  charged_credits?: number;
  charged_usd?: number;
  error_code?: string;
}

function rowFromTask(task: TaskResponse): Row {
  const row: Row = { task_id: task.id, status: task.status, model: task.model, type: task.type, progress: task.progress };
  if (task.created) row.created_at = new Date(task.created * 1000).toISOString();
  const links = resultLinks(task);
  if (links.length > 0) row.results = links;
  const used = task.usage?.credits_used ?? task.usage?.cost?.credits;
  if (task.status === 'completed' && typeof used === 'number') {
    row.charged_credits = used;
    row.charged_usd = task.usage?.cost?.usd ?? usdOf(used);
  }
  if (task.error?.code) row.error_code = task.error.code;
  return row;
}

function rowLine(row: Row): string {
  const parts = [`- ${row.task_id}`, row.status === 'completed' || row.status === 'failed' ? row.status : `${row.status} ${row.progress ?? 0}%`, row.model];
  if (row.created_at) parts.push(row.created_at);
  if (row.charged_credits !== undefined) parts.push(`charged ${money(row.charged_credits)}`);
  if (row.error_code) parts.push(`error ${row.error_code}`);
  const lines = [parts.join(' · ')];
  for (const link of row.results ?? []) lines.push(`    ${link.kind}: ${link.url}`);
  return lines.join('\n');
}

export function registerListTasks(server: McpServer, config: ServerConfig): void {
  server.registerTool('list_tasks', {
    title: 'List generation tasks',
    description: [
      'Read several tasks at once by task_ids (up to 50, with result links), or find recent tasks by status, type and since. Free.',
      'Use it to recover tasks after a lost connection or a timed-out submit before submitting anything again.',
      'Recent tasks cover the whole EvoLink account, newest first.',
    ].join(' '),
    inputSchema: {
      task_ids: z.array(z.string().regex(TASK_ID)).min(1).max(MAX_IDS).optional()
        .describe('Task IDs to read in one call (max 50).'),
      status: z.enum(['processing', 'completed', 'failed', 'cancelled']).optional()
        .describe('Without task_ids: only tasks in this state ("processing" includes queued tasks).'),
      type: z.enum(['image', 'video', 'audio']).optional()
        .describe('Without task_ids: only this kind of task.'),
      since: z.string().max(40).optional()
        .describe('Without task_ids: only tasks created after this time, as ISO 8601 (2026-10-05T08:00:00Z) or relative (30m, 2h, 1d).'),
      limit: z.number().int().min(1).max(MAX_IDS).default(20)
        .describe('Without task_ids: how many recent tasks to return (1–50, default 20).'),
    },
    annotations: { title: 'List generation tasks', ...READ_ONLY },
  }, async ({ task_ids, status, type, since, limit }) => {
    try {
      if (task_ids && task_ids.length > 0) {
        const unique = [...new Set(task_ids)];
        const tasks = await queryTasks(config, unique);
        const rows = tasks.map(rowFromTask);
        const found = new Set(rows.map(row => row.task_id));
        const missing = unique.filter(id => !found.has(id));
        const lines = [`${rows.length} of ${unique.length} tasks found.`, ...rows.map(rowLine)];
        if (missing.length > 0) lines.push(`Not found (wrong ID, expired, or another account): ${missing.join(', ')}`);
        if (rows.some(row => row.results)) lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
        return ok(lines.join('\n'), { tasks: rows, missing });
      }

      let sinceMs: number | undefined;
      if (since) {
        sinceMs = parseSince(since);
        if (sinceMs === undefined) {
          return failure(`since "${since}" is not a time. Use ISO 8601 (2026-10-05T08:00:00Z) or a relative value such as 30m, 2h or 1d.`, {
            error: { category: 'invalid_request', param: 'since' },
          });
        }
      }
      const pageSize = limit ?? 20;
      const page = await listTasks(config, { status, type, pageSize });
      let items = page.data;
      if (sinceMs !== undefined) items = items.filter(item => item.created_at * 1000 >= sinceMs!);

      // The list endpoint omits result links; read finished tasks in one batch to include them.
      const finished = items.filter(item => item.status === 'completed' && item.has_results).map(item => item.id).slice(0, MAX_IDS);
      const details = new Map<string, TaskResponse>();
      if (finished.length > 0) {
        for (const task of await queryTasks(config, finished)) details.set(task.id, task);
      }
      const rows: Row[] = items.map(item => {
        const detailed = details.get(item.id);
        if (detailed) return rowFromTask(detailed);
        const row: Row = {
          task_id: item.id,
          status: item.status,
          model: item.model,
          type: item.type,
          progress: item.progress,
          created_at: new Date(item.created_at * 1000).toISOString(),
        };
        if (typeof item.credits_used === 'number' && item.status === 'completed') {
          row.charged_credits = item.credits_used;
          row.charged_usd = usdOf(item.credits_used);
        }
        if (item.has_error) row.error_code = 'failed';
        return row;
      });
      const filters = [status && `status ${status}`, type && `type ${type}`, since && `since ${since}`].filter(Boolean).join(', ');
      const lines = [`${rows.length} recent task${rows.length === 1 ? '' : 's'} on this account${filters ? ` (${filters})` : ''}, newest first:`];
      lines.push(...(rows.length > 0 ? rows.map(rowLine) : ['(none)']));
      if (page.total > page.data.length) lines.push(`${page.total} tasks match in total; raise limit or narrow the filters to see others.`);
      if (rows.some(row => row.results)) lines.push(`Result links expire after ${RESULT_LINK_HOURS} hours.`);
      return ok(lines.join('\n'), { tasks: rows, total: page.total });
    } catch (error) {
      return errorResult(error);
    }
  });
}
