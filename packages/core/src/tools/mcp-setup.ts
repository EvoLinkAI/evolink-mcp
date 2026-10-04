import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCatalogSetup } from '../services/catalog-client.js';

const schema = {
  model: z.string().describe('Canonical media model ID to validate for MCP compatibility.'),
};

export function registerMCPSetup(server: McpServer): void {
  server.tool(
    'mcp_setup',
    'Read versioned, secret-free EvoLink MCP setup facts for one canonical model.',
    schema,
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (params) => {
      try {
        const result = await getCatalogSetup(params.model);
        const lines = [
          `Model: ${result.data.model_id}`,
          `Catalog: ${result.data.meta.catalog_version} (${result.source})`,
          `Command: ${String(result.data.config.command ?? 'evolink-mcp')}`,
          'Credential helper: evolink credential get (the Agent Key is not returned by this tool)',
        ];
        for (const warning of result.data.warnings ?? []) lines.push(`Warning: ${warning}`);
        if (result.warning) lines.push(`Warning: ${result.warning}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `MCP setup facts are unavailable: ${error instanceof Error ? error.message : 'unknown error'}` }],
          isError: true,
        };
      }
    },
  );
}
