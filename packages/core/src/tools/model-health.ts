import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCatalogHealth } from '../services/catalog-client.js';

const schema = {
  model: z.string().optional().describe('Optional canonical model ID. Omit to inspect all published model health records.'),
};

export function registerModelHealth(server: McpServer): void {
  server.tool(
    'model_health',
    'Read current canonical model availability before choosing or invoking a model.',
    schema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (params) => {
      try {
        const result = await getCatalogHealth(params.model);
        if (result.data.models.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No health record matched the requested model.' }], isError: true };
        }
        const lines = [
          `Catalog: ${result.data.meta.catalog_version} (${result.source})`,
          ...result.data.models.map(model => `${model.model_id}: ${model.status} · observed ${model.observed_at}`),
        ];
        if (result.warning) lines.push(`Warning: ${result.warning}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Model health is unavailable: ${error instanceof Error ? error.message : 'unknown error'}` }],
          isError: true,
        };
      }
    },
  );
}
