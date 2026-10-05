import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadCatalog, type CatalogEntry } from '../services/model-catalog.js';
import { formatPrice, startingPrice } from '../services/pricing-client.js';
import { READ_ONLY, errorResult, ok } from './shared.js';

export function modelTitle(entry: CatalogEntry): string | undefined {
  const title = entry.spec?.title?.replace(/\s+(interface|api)$/i, '').trim();
  return title || entry.priced?.description?.slice(0, 120) || undefined;
}

/** Every term must appear somewhere; matches in the model ID count most. */
function score(entry: CatalogEntry, terms: string[]): number | undefined {
  if (terms.length === 0) return 0;
  const id = entry.id.toLowerCase();
  const haystack = [id, modelTitle(entry), entry.priced?.description, entry.priced?.vendor, entry.kind]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (id === term) total += 10;
    else if (id.startsWith(term)) total += 6;
    else if (id.includes(term)) total += 4;
    else if (haystack.includes(term)) total += 1;
    else return undefined;
  }
  return total;
}

export function registerSearchModels(server: McpServer): void {
  server.registerTool('search_models', {
    title: 'Search models',
    description: [
      'Find EvoLink image, video and audio models by type and keywords. Free.',
      'Returns model IDs with a starting price; call get_model for a model\'s parameters and full pricing before generating.',
      'Prices are in USD (68 credits ≈ $1).',
    ].join(' '),
    inputSchema: {
      type: z.enum(['image', 'video', 'audio', 'all']).default('all').describe('Kind of output to look for.'),
      query: z.string().max(100).optional().describe('Keywords, e.g. "seedance", "image-to-video", "kling", "music".'),
      limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of models to return (1–50, default 20).'),
    },
    annotations: { title: 'Search models', ...READ_ONLY },
  }, async ({ type, query, limit }) => {
    try {
      const catalog = await loadCatalog();
      const terms = (query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
      const matches = catalog.entries
        .filter(entry => type === 'all' || entry.kind === type)
        .map(entry => ({ entry, score: score(entry, terms), start: entry.priced ? startingPrice(entry.priced) : undefined }))
        .filter((item): item is { entry: CatalogEntry; score: number; start: ReturnType<typeof startingPrice> } => item.score !== undefined)
        .sort((a, b) => b.score - a.score || Number(!!b.start) - Number(!!a.start) || a.entry.id.localeCompare(b.entry.id));
      const shown = matches.slice(0, limit ?? 20);

      const models = shown.map(({ entry, start }) => ({
        id: entry.id,
        type: entry.kind,
        title: modelTitle(entry),
        from_usd: start?.min_usd,
        from_unit: start?.unit,
        parameters_documented: !!entry.spec,
        docs: entry.spec?.docs,
      }));
      const lines = [
        `${matches.length} model${matches.length === 1 ? '' : 's'} match${terms.length ? ` "${query}"` : ''}${type !== 'all' ? ` (${type})` : ''}${matches.length > shown.length ? `; showing ${shown.length}` : ''}:`,
        ...shown.map(({ entry, start }) => {
          const parts = [`- ${entry.id} [${entry.kind}]`];
          const title = modelTitle(entry);
          if (title) parts.push(title);
          parts.push(start ? `from ${formatPrice(start)}` : 'price not published');
          if (!entry.spec) parts.push('parameters not documented');
          return parts.join(' · ');
        }),
      ];
      if (matches.length === 0) lines.push('No model matched. Try fewer or broader keywords, or type "all".');
      else lines.push('', 'Next: get_model with one of these IDs for its parameters and pricing.');
      if (catalog.pricingWarning) lines.push(`Note: ${catalog.pricingWarning}`);
      return ok(lines.join('\n'), {
        models,
        total_matches: matches.length,
        ...(catalog.pricingWarning ? { pricing_warning: catalog.pricingWarning } : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  });
}
