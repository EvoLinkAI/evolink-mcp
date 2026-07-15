import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getModelsByCategory } from '../data/models.js';
import { getCatalogModels } from '../services/catalog-client.js';

const schema = {
  category: z.enum(['video', 'image', 'music', 'all']).default('all')
    .describe('Filter models by category'),
};

export function registerListModels(server: McpServer): void {
  server.tool(
    'list_models',
    'List available AI models with features. Use to help users choose the right model.',
    schema,
    async (params) => {
      const capability = params.category === 'music' ? 'audio' : params.category === 'all' ? undefined : params.category;
      try {
        const result = await getCatalogModels(capability, undefined);
        const models = result.data.models.filter(model => model.lifecycle !== 'retired');
        const lines = models.map(model => [
          `**${model.model_id}**${model.lifecycle === 'preview' ? ' [PREVIEW]' : model.lifecycle === 'deprecated' ? ' [DEPRECATED]' : ''}`,
          `  ${model.display_name} · ${model.provider}`,
          `  Capabilities: ${model.capabilities.join(', ') || 'unspecified'}`,
          `  Protocols: ${model.protocols.join(', ') || 'unspecified'}`,
        ].join('\n'));
        const warnings = result.warning ? `\n\nWarning: ${result.warning}` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Canonical models (${models.length}) · catalog ${result.data.meta.catalog_version} · ${result.source}:\n\n${lines.join('\n\n')}${warnings}`,
          }],
        };
      } catch (error) {
        const models = getModelsByCategory(params.category);
        const lines = models.map(m => {
          const badge = m.isBeta ? ' [BETA]' : '';
          return [
            `**${m.name}**${badge} [${m.category}]`,
            `  ${m.description}`,
            `  Features: ${m.features.join(', ')}`,
          ].join('\n');
        });
        const reason = error instanceof Error ? error.message : 'unknown Catalog failure';

        return {
          content: [{
            type: 'text' as const,
            text: `Warning: Canonical Catalog is unavailable (${reason}). Bundled fallback may be stale.\n\nAvailable fallback models (${models.length}):\n\n${lines.join('\n\n')}`,
          }],
        };
      }
    },
  );
}
