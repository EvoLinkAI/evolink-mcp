import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import type { MediaKind } from '../data/model-params.js';
import { submitTask } from '../services/api-client.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput } from '../services/param-validator.js';
import { estimateCost, formatEstimateRange, type CostEstimate } from '../services/pricing-client.js';
import { CLIENT_REQUEST_ID_PATTERN, newRunId } from '../services/http-policy.js';
import { formatUsd } from '../services/error-handler.js';
import { PAID, errorResult, failure, money, ok, progressReporter, usdOf } from './shared.js';
import { TERMINAL_STATUSES, describeTask, waitForTask } from './task-format.js';

const PATHS: Record<MediaKind, string> = {
  image: '/v1/images/generations',
  video: '/v1/videos/generations',
  audio: '/v1/audios/generations',
};

/** Images usually finish in seconds, so the tool waits for them; video and audio return the task at once. */
const WAIT_MS: Record<MediaKind, number> = { image: 40_000, video: 0, audio: 0 };

const DESCRIPTIONS: Record<MediaKind, string> = {
  image: 'Generate or edit images with an EvoLink image model. PAID: charges the user\'s EvoLink balance.',
  video: 'Generate a video with an EvoLink video model (text-to-video, image-to-video, reference, edit, extend). PAID: charges the user\'s EvoLink balance.',
  audio: 'Generate music, songs or speech with an EvoLink audio model. PAID: charges the user\'s EvoLink balance.',
};

const AFTER: Record<MediaKind, string> = {
  image: 'Waits up to 40 s and returns the image links when ready; otherwise returns the task_id for get_task.',
  video: 'Returns a task_id at once (videos take minutes); then call get_task, which can wait up to 45 s per call.',
  audio: 'Returns a task_id at once; then call get_task, which can wait up to 45 s per call.',
};

function description(kind: MediaKind): string {
  return [
    DESCRIPTIONS[kind],
    'Before calling, get the price with estimate_cost (or get_model) and tell the user, unless they already approved this spend.',
    'Find models with search_models and their parameters with get_model; pass the parameters in input.',
    AFTER[kind],
    'Never call this again to check progress or to "retry" a running task: each call creates and charges a new task.',
    'After a network error or timeout, reuse the same client_request_id to retry without being charged twice.',
  ].join(' ');
}

function rangeText(estimate: CostEstimate): string {
  return formatEstimateRange(estimate) ?? 'unknown';
}

export function registerGenerateTools(server: McpServer, config: ServerConfig): void {
  for (const kind of ['image', 'video', 'audio'] as const) registerGenerate(server, config, kind);
}

function registerGenerate(server: McpServer, config: ServerConfig, kind: MediaKind): void {
  const name = `generate_${kind}`;
  const title = `Generate ${kind} (paid)`;
  server.registerTool(name, {
    title,
    description: description(kind),
    inputSchema: {
      model: z.string().min(1).max(128).describe(`${kind[0].toUpperCase()}${kind.slice(1)} model ID from search_models.`),
      prompt: z.string().max(20_000).optional().describe('Shortcut for input.prompt.'),
      input: z.record(z.unknown()).optional()
        .describe('Model parameters exactly as listed by get_model, e.g. {"prompt":"…","quality":"1080p"}. Do not put model or callback_url here.'),
      client_request_id: z.string().regex(CLIENT_REQUEST_ID_PATTERN).optional()
        .describe('Optional idempotency key (16–96 characters: letters, digits, . _ -). Reuse the same value only to retry the same request after a network error or timeout.'),
      max_cost_usd: z.number().positive().max(10_000).optional()
        .describe('Optional spending cap: if the estimated cost is higher, nothing is submitted.'),
    },
    annotations: { title, ...PAID },
  }, async (args, extra) => {
    const started = Date.now();
    const input: Record<string, unknown> = { ...(args.input ?? {}) };
    if (args.prompt !== undefined) {
      if (input.prompt !== undefined && input.prompt !== args.prompt) {
        return failure('prompt was given twice with different values (prompt and input.prompt). Pass it once. Nothing was submitted or charged.', {
          error: { category: 'invalid_request', param: 'prompt' },
          charged: 'no',
        });
      }
      input.prompt = args.prompt;
    }

    let clientRequestId: string | undefined;
    try {
      const { catalog, entry } = await resolveModel(args.model);
      if (!entry) {
        const suggestions = suggestModels(catalog, args.model, kind);
        return failure(
          `Unknown ${kind} model "${args.model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs. Nothing was submitted or charged.`,
          { error: { category: 'not_found', param: 'model' }, suggestions, charged: 'no' },
        );
      }
      if (entry.kind !== kind) {
        return failure(`${entry.id} is a ${entry.kind} model; use generate_${entry.kind}. Nothing was submitted or charged.`, {
          error: { category: 'invalid_request', param: 'model' },
          use_tool: `generate_${entry.kind}`,
          charged: 'no',
        });
      }

      const warnings: string[] = [];
      if (entry.spec) {
        const validation = validateInput(entry.spec, input);
        if (validation.errors.length > 0) {
          return failure([
            `The input for ${entry.id} has problems; nothing was submitted or charged:`,
            ...formatIssues(validation.errors),
            'get_model lists every parameter with its allowed values.',
          ].join('\n'), { error: { category: 'invalid_request' }, problems: validation.errors, charged: 'no' });
        }
        warnings.push(...validation.warnings.map(issue => `${issue.param} ${issue.problem}`));
      } else {
        warnings.push('This model\'s parameters are not documented here, so the input was not checked before sending.');
      }

      const estimate = estimateCost(entry.priced, kind, input, entry.spec);
      if (args.max_cost_usd !== undefined) {
        if (estimate.status !== 'estimated' || estimate.max_usd === undefined) {
          const reason = estimate.status === 'token_billed'
            ? 'it is billed by tokens used, so its cost is only known afterwards'
            : estimate.notes[0] ?? catalog.pricingWarning ?? 'no price could be found for it';
          return failure(`max_cost_usd cannot be checked for ${entry.id}: ${reason}. Nothing was submitted or charged. Ask the user whether to proceed without a cap.`, {
            error: { category: 'invalid_request', param: 'max_cost_usd' },
            estimate,
            charged: 'no',
          });
        }
        if (estimate.max_usd > args.max_cost_usd) {
          return failure(`The estimated cost ${rangeText(estimate)} is above max_cost_usd $${formatUsd(args.max_cost_usd)}. Nothing was submitted or charged. Lower the duration, count or quality, or ask the user to raise the cap.`, {
            error: { category: 'invalid_request', param: 'max_cost_usd' },
            estimate,
            charged: 'no',
          });
        }
      }

      clientRequestId = args.client_request_id ?? newRunId();
      const body = { ...input, model: entry.id };
      const submitted = await submitTask(config, {
        path: entry.spec?.path ?? PATHS[kind],
        body,
        tool: name,
        idempotencyKey: clientRequestId,
      });

      let task = submitted;
      const waitUntil = started + WAIT_MS[kind];
      if (!TERMINAL_STATUSES.has(task.status) && WAIT_MS[kind] > 0 && Date.now() + 3_000 < waitUntil) {
        const report = progressReporter(extra, WAIT_MS[kind] / 1000);
        try {
          task = await waitForTask(config, submitted.id, {
            deadline: waitUntil,
            tool: name,
            signal: extra.signal,
            onPoll: current => report((Date.now() - started) / 1000, `${current.status}, ${current.progress ?? 0}%`),
          });
        } catch {
          // The task exists; a failed status read must not turn a successful submit into an error.
          task = submitted;
        }
        task.usage = { ...submitted.usage, ...task.usage };
      }

      const view = describeTask({ ...task, request_id: task.request_id ?? submitted.request_id });
      const header = submitted.idempotency_replayed
        ? `This client_request_id was used before: returning the original task (no new charge).`
        : `Submitted ${entry.id}.`;
      const lines = [header, ...view.lines];
      const reserved = submitted.usage?.credits_reserved;
      if (typeof reserved === 'number' && reserved > 0 && !lines.some(line => line.startsWith('Reserved:')) && task.status !== 'completed') {
        lines.push(`Reserved: ${money(reserved)}`);
      }
      if (estimate.status === 'estimated') lines.push(`Estimate before submitting: ${rangeText(estimate)}`);
      for (const warning of warnings) lines.push(`Warning: ${warning}`);
      lines.push(`client_request_id: ${clientRequestId}`);
      return ok(lines.join('\n'), {
        ...view.structured,
        submitted: { model: entry.id, input },
        client_request_id: clientRequestId,
        replayed: submitted.idempotency_replayed === true,
        ...(typeof reserved === 'number' ? { reserved_credits: reserved, reserved_usd: usdOf(reserved) } : {}),
        ...(estimate.status === 'estimated' ? { estimate: { min_usd: estimate.min_usd, max_usd: estimate.max_usd } } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    } catch (error) {
      // clientRequestId is set right before the submit, so it also tells whether a request may have gone out.
      return errorResult(error, { paid: clientRequestId !== undefined, clientRequestId });
    }
  });
}
