import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { getCredits } from '../services/api-client.js';
import { resolveModel, suggestModels } from '../services/model-catalog.js';
import { formatIssues, validateInput, type ValidationResult } from '../services/param-validator.js';
import { estimateCost, formatEstimateRange } from '../services/pricing-client.js';
import { API_KEYS_URL, MCP_CONSOLE_URL, TOP_UP_URL } from '../services/http-policy.js';
import { currentCredentialMode } from '../request-context.js';
import { READ_ONLY, errorResult, failure, money, ok } from './shared.js';

export function registerEstimateCost(server: McpServer, config: ServerConfig): void {
  server.registerTool('estimate_cost', {
    title: 'Estimate cost',
    description: [
      'Check a generation input and estimate what it will cost, without submitting anything. Free.',
      'Returns whether the input is valid, the expected price range in USD and credits, what it is based on, and whether the account balance and any spending limit (the EvoLink MCP limit, or this API key\'s) cover it.',
      'Call it before a paid generate_* call and tell the user the price.',
    ].join(' '),
    inputSchema: {
      model: z.string().min(1).max(128).describe('Model ID, e.g. "seedance-2.0-text-to-video".'),
      input: z.record(z.unknown()).optional()
        .describe('The input you plan to pass to the generate tool, e.g. {"prompt":"…","duration":5,"quality":"1080p"}.'),
    },
    annotations: { title: 'Estimate cost', ...READ_ONLY },
  }, async ({ model, input }) => {
    try {
      const { catalog, entry } = await resolveModel(model);
      if (!entry) {
        const suggestions = suggestModels(catalog, model);
        return failure(
          `Unknown model "${model}".${suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : ''} Use search_models to find model IDs.`,
          { error: { category: 'not_found', param: 'model' }, suggestions },
        );
      }
      const values = input ?? {};
      const validation: ValidationResult | undefined = entry.spec ? validateInput(entry.spec, values) : undefined;
      const estimate = estimateCost(entry.priced, entry.kind, values, entry.spec);

      const lines = [`Estimate for ${entry.id} (${entry.kind}); nothing was submitted or charged.`];
      if (!validation) {
        lines.push('Input not checked: this model\'s parameters are not documented here.');
      } else if (validation.errors.length > 0) {
        lines.push(`Input problems (generate_${entry.kind} would refuse this input):`, ...formatIssues(validation.errors));
      } else {
        lines.push('Input looks valid.');
      }
      if (validation?.warnings.length) lines.push('Warnings:', ...formatIssues(validation.warnings));

      const range = formatEstimateRange(estimate);
      if (estimate.status === 'estimated' && range) lines.push(`Estimated cost: ${range}`);
      else if (estimate.status === 'token_billed') lines.push('Cost: billed by tokens used; it is only known after the task runs.');
      else if (estimate.status === 'needs_input') lines.push('Cost: cannot estimate yet; see the note below.');
      else lines.push('Cost: no published price to estimate from.');
      if (estimate.basis.length) lines.push('Based on:', ...estimate.basis.map(line => `- ${line}`));
      if (estimate.possible_extras.length) lines.push('May also charge:', ...estimate.possible_extras.map(line => `- ${line}`));
      for (const note of estimate.notes) lines.push(`Note: ${note}`);

      const structured: Record<string, unknown> = {
        model: entry.id,
        type: entry.kind,
        input_valid: validation ? validation.errors.length === 0 : null,
        problems: validation?.errors ?? [],
        warnings: validation?.warnings ?? [],
        estimate,
      };
      try {
        const credits = await getCredits(config, 'estimate_cost');
        const balance = Math.max(0, credits.user.remaining_credits);
        lines.push(`Account balance: ${money(balance)}`);
        structured.balance_credits = balance;
        if (estimate.max_credits !== undefined) {
          const enough = balance >= estimate.max_credits;
          structured.enough_balance = enough;
          if (!enough) lines.push(`The account balance may not cover this; top up at ${TOP_UP_URL}.`);
        }
        // The key's own limit is checked before the balance: warn now instead of failing on submit.
        if (!credits.token.unlimited_credits) {
          const signedIn = currentCredentialMode() === 'signed_in';
          const left = Math.max(0, credits.token.remaining_credits);
          lines.push(signedIn
            ? `EvoLink MCP limit left: ${money(left)} (shared by all connected assistants).`
            : `This API key's limit left: ${money(left)}.`);
          structured.limit_scope = signedIn ? 'mcp' : 'api_key';
          structured.limit_remaining_credits = left;
          if (estimate.max_credits !== undefined) {
            const enoughLimit = left >= estimate.max_credits;
            structured.enough_limit = enoughLimit;
            if (!enoughLimit) {
              lines.push(signedIn
                ? `The EvoLink MCP limit may not cover this. It is a limit the user set, not the account balance; they can raise it at ${MCP_CONSOLE_URL}.`
                : `This API key's limit may not cover this; raise it at ${API_KEYS_URL} or use another key.`);
            }
          }
        }
      } catch {
        lines.push('Balance: could not be read right now.');
      }
      if (catalog.pricingWarning) {
        lines.push(`Note: ${catalog.pricingWarning}`);
        structured.pricing_warning = catalog.pricingWarning;
      }
      lines.push('This is an estimate from published prices. The amount actually reserved is shown when the task is submitted, and the final charge when it finishes.');
      return ok(lines.join('\n'), structured);
    } catch (error) {
      return errorResult(error);
    }
  });
}
