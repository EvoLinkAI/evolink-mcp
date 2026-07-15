import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findModel } from '../data/models.js';
import { getCatalogPricing } from '../services/catalog-client.js';

const schema = {
  model: z.string().describe('Model name to check info for'),
};

export function registerEstimateCost(server: McpServer): void {
  server.tool(
    'estimate_cost',
    'Show canonical unit prices and model facts before generation. This is not a workload-specific billing guarantee.',
    schema,
    async (params) => {
      try {
        const result = await getCatalogPricing(params.model);
        const prices = result.data.prices.filter(price => price.model_id === params.model);
        if (prices.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No active canonical price is published for ${params.model}. Do not infer a price from bundled data.` }],
            isError: true,
          };
        }
        const lines = [
          `Model: ${params.model}`,
          `Catalog: ${result.data.meta.catalog_version} (${result.source})`,
          ...prices.map(price => `${price.role}: ${price.currency} ${price.price} ${price.unit} · effective ${price.effective_at}`),
          '',
          'These are canonical unit prices, not a request-specific estimate. Use `evolink estimate` for authenticated text workload estimates and require confirm_cost=true before generation.',
        ];
        if (result.warning) lines.push(`Warning: ${result.warning}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (error) {
        const model = findModel(params.model);
        const reason = error instanceof Error ? error.message : 'unknown Catalog failure';
        return {
          content: [{
            type: 'text' as const,
            text: model
              ? `Canonical pricing is unavailable (${reason}). ${model.name} exists only in the bundled fallback; no cost is asserted.`
              : `Model "${params.model}" was not found and canonical pricing is unavailable (${reason}).`,
          }],
          isError: true,
        };
      }
    },
  );
}
