import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { estimateWorkload } from '../services/catalog-client.js';

const schema = {
  model: z.string().describe('Canonical model ID to estimate'),
  operation: z.enum(['text-generation', 'image-generation', 'video-generation', 'audio-generation'])
    .describe('Workload type; it must match the model capability'),
  input_tokens: z.number().int().min(1).max(10_000_000).optional()
    .describe('Required for text-generation'),
  max_output_tokens: z.number().int().min(1).max(10_000_000).optional()
    .describe('Required for text-generation'),
  count: z.number().int().min(1).max(16).optional()
    .describe('Required for image-generation'),
  duration_seconds: z.number().int().min(1).max(3600).optional()
    .describe('Required for video-generation and audio-generation'),
  quality: z.string().max(32).optional().describe('Optional canonical quality tier such as 1080p or 4k'),
};

export function registerEstimateCost(server: McpServer): void {
  server.tool(
    'estimate_cost',
    'Calculate a request-specific maximum estimate with EvoLink production SKU rules. This does not submit a paid generation.',
    schema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        const estimate = await estimateWorkload(params.model, params.operation, {
          input_tokens: params.input_tokens,
          max_output_tokens: params.max_output_tokens,
          count: params.count,
          duration_seconds: params.duration_seconds,
          quality: params.quality,
        });
        const lines = [
          `Estimate: ${estimate.estimate_id}`,
          `Model: ${estimate.model_id}`,
          `Operation: ${estimate.operation}`,
          `Catalog: ${estimate.catalog_version}`,
          `Estimated maximum cost: ${estimate.currency} ${estimate.amount}`,
          `Valid until: ${estimate.expires_at}`,
          '',
          ...estimate.assumptions.map(value => `- ${value}`),
          '',
          'This estimate does not submit or reserve a paid task. A separate generation call still requires confirm_cost=true.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown estimate failure';
        return {
          content: [{
            type: 'text' as const,
            text: `A production-aligned workload estimate is unavailable for ${params.model}: ${reason}. Do not infer a price or submit a paid generation without a successful estimate.`,
          }],
          isError: true,
        };
      }
    },
  );
}
