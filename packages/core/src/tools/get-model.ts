import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { modelParamsMeta, type ParamSpec } from '../data/model-params.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatPrice, type SkuPrice } from '../services/pricing-client.js';
import { formatUsd } from '../services/error-handler.js';
import { READ_ONLY, errorResult, failure, ok } from './shared.js';
import { modelTitle } from './search-models.js';

function value(v: unknown): string {
  return JSON.stringify(v);
}

export function describeParam(name: string, spec: ParamSpec, indent = ''): string[] {
  const facts = [spec.type, spec.required ? 'required' : undefined].filter(Boolean);
  const details: string[] = [];
  if (spec.enum?.length) details.push(`one of ${spec.enum.map(value).join(', ')}`);
  if (spec.default !== undefined) details.push(`default ${value(spec.default)}`);
  if (spec.minimum !== undefined || spec.maximum !== undefined) details.push(`range ${spec.minimum ?? '…'}–${spec.maximum ?? '…'}`);
  if (spec.minItems !== undefined || spec.maxItems !== undefined) details.push(`${spec.minItems ?? 0}–${spec.maxItems ?? '…'} items`);
  if (spec.maxLength !== undefined) details.push(`up to ${spec.maxLength} characters`);
  if (spec.items?.enum?.length) details.push(`each one of ${spec.items.enum.map(value).join(', ')}`);
  const head = `${indent}- ${name}${facts.length ? ` (${facts.join(', ')})` : ''}${details.length ? `: ${details.join('; ')}` : ''}`;
  const lines = [spec.description ? `${head} — ${spec.description}` : head];
  for (const [child, childSpec] of Object.entries(spec.properties ?? spec.items?.properties ?? {})) {
    lines.push(...describeParam(child, childSpec, `${indent}  `));
  }
  return lines;
}

function priceLine(price: SkuPrice): string {
  const minimum = price.min_charge_usd !== undefined ? ` (minimum $${formatUsd(price.min_charge_usd)} per task)` : '';
  const factors = price.multipliers ? ` (resolution factors ${Object.entries(price.multipliers).map(([k, v]) => `${k} ×${v}`).join(', ')})` : '';
  return `${price.name}: ${formatPrice(price)}${minimum}${factors}`;
}

export function registerGetModel(server: McpServer): void {
  server.registerTool('get_model', {
    title: 'Get model parameters and pricing',
    description: [
      'Show what one model accepts and what it costs: every input parameter (required, allowed values, ranges, defaults), the published prices and an example input. Free.',
      'Read this before calling generate_image, generate_video or generate_audio, and quote the price to the user.',
    ].join(' '),
    inputSchema: {
      model: z.string().min(1).max(128).describe('Model ID from search_models, e.g. "seedance-2.0-text-to-video".'),
    },
    annotations: { title: 'Get model parameters and pricing', ...READ_ONLY },
  }, async ({ model }) => {
    try {
      const { catalog, entry } = await resolveModel(model);
      if (!entry) {
        const suggestions = suggestModels(catalog, model);
        return failure(
          `Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`,
          { error: { category: 'not_found', param: 'model' }, suggestions },
        );
      }
      const { spec, priced } = entry;
      const title = modelTitle(entry);
      const lines = [`${entry.id} (${entry.kind})${title ? ` — ${title}` : ''}`, `Generate with: generate_${entry.kind}`];
      const structured: Record<string, unknown> = {
        model: entry.id,
        type: entry.kind,
        tool: `generate_${entry.kind}`,
      };

      if (spec) {
        lines.push(`Docs: ${spec.docs}`, '', 'Input parameters (pass them in input):');
        const names = Object.keys(spec.params).sort((a, b) => Number(!!spec.params[b].required) - Number(!!spec.params[a].required));
        for (const name of names) lines.push(...describeParam(name, spec.params[name]));
        if (spec.example) lines.push('', `Example input: ${JSON.stringify(spec.example)}`);
        Object.assign(structured, {
          endpoint: spec.path,
          docs: spec.docs,
          required: spec.required,
          parameters: spec.params,
          example_input: spec.example,
          parameters_source: modelParamsMeta(),
        });
      } else {
        lines.push('', 'Parameters for this model are not documented here; the gateway checks the input when you submit.');
      }

      lines.push('', 'Pricing (USD; 68 credits ≈ $1):');
      if (priced && priced.prices.length > 0) {
        const groups: Array<[SkuPrice['role'], string]> = [['output', 'Main charge'], ['add_on', 'Extra charges'], ['token', 'Usage-based']];
        for (const [role, label] of groups) {
          const prices = priced.prices.filter(price => price.role === role);
          if (prices.length === 0) continue;
          lines.push(`${label}:`);
          for (const price of prices) lines.push(`- ${priceLine(price)}`);
        }
        lines.push('Use estimate_cost with your input for a total before generating.');
        structured.prices = priced.prices;
      } else {
        lines.push(catalog.pricingWarning ?? 'No price is published for this model.');
      }
      if (catalog.pricingWarning) structured.pricing_warning = catalog.pricingWarning;
      return ok(lines.join('\n'), structured);
    } catch (error) {
      return errorResult(error);
    }
  });
}
