import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { READ_ONLY, errorResult, ok, progressReporter } from './shared.js';
import { TERMINAL_STATUSES, describeTask, waitForTask } from './task-format.js';

export const TASK_ID = /^[A-Za-z0-9._:-]{4,128}$/;
/** Codex and Cursor drop a tool call after about 60 s; the reply also needs time to travel. */
export const MAX_WAIT_SECONDS = 45;
const REPLY_MARGIN_MS = 2_000;
const PROGRESS_EVERY_SECONDS = 10;

export function registerGetTask(server: McpServer, config: ServerConfig): void {
  server.registerTool('get_task', {
    title: 'Get task status and results',
    description: [
      'Check one generation task and, while it is still running, wait up to wait_seconds (max 45) for it to finish. Free.',
      'Returns the status, progress, result links (they expire after 24 hours, so give them to the user right away), the final charge, or the error with a next step.',
      'If the task is still running when this returns, call get_task again.',
      'Never call generate_image, generate_video or generate_audio again to check progress: that creates and charges a new task.',
    ].join(' '),
    inputSchema: {
      task_id: z.string().regex(TASK_ID).describe('task_id returned by generate_image, generate_video or generate_audio'),
      wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(30)
        .describe('How long this call may wait for the task to finish (0–45 s, default 30). Use 0 for a quick check.'),
    },
    annotations: { title: 'Get task status and results', ...READ_ONLY },
  }, async ({ task_id, wait_seconds }, extra) => {
    const started = Date.now();
    const waitSeconds = Math.min(wait_seconds ?? 30, MAX_WAIT_SECONDS);
    const report = progressReporter(extra, waitSeconds);
    let lastReport = -PROGRESS_EVERY_SECONDS;
    try {
      const task = await waitForTask(config, task_id, {
        deadline: started + waitSeconds * 1000 - REPLY_MARGIN_MS,
        tool: 'get_task',
        signal: extra.signal,
        onPoll: async current => {
          const elapsed = (Date.now() - started) / 1000;
          if (elapsed - lastReport < PROGRESS_EVERY_SECONDS) return;
          lastReport = elapsed;
          await report(elapsed, `${current.status}, ${current.progress ?? 0}%`);
        },
      });
      const view = describeTask(task);
      if (!TERMINAL_STATUSES.has(task.status) && waitSeconds > 0) {
        const waited = Math.round((Date.now() - started) / 1000);
        view.lines.splice(1, 0, `Still running after waiting ${waited} s.`);
        view.structured.waited_seconds = waited;
      }
      return ok(view.lines.join('\n'), view.structured);
    } catch (error) {
      return errorResult(error);
    }
  });
}
