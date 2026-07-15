import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RouterConfig } from '../config.js';
import { PaidRequestOutcomeUnknownError, chatRequest } from '../services/api-client.js';
import { CASCADE_CHAIN, findModel } from '../data/text-models.js';
import { getTextCatalog } from '../services/catalog-client.js';

type Confidence = 'high' | 'medium' | 'low';

const CONFIDENCE_SUFFIX = `

IMPORTANT: At the very end of your response, on a new line, output exactly one of these confidence tags (nothing else on that line):
[CONFIDENCE:high] — if you are very confident your answer is complete and correct
[CONFIDENCE:medium] — if you are somewhat confident but a stronger model might do better
[CONFIDENCE:low] — if you are unsure or the task exceeds your capability`;

function parseConfidence(text: string): { content: string; confidence: Confidence } {
  const match = text.match(/\[CONFIDENCE:(high|medium|low)\]\s*$/);
  const confidence = (match?.[1] as Confidence) ?? 'medium';
  const content = match ? text.slice(0, match.index).trimEnd() : text;
  return { content, confidence };
}

export function registerCascade(server: McpServer, config: RouterConfig): void {
  const schema = {
    prompt: z.string().max(100000).describe('The prompt / task to complete'),
    system_prompt: z.string().max(10000).optional()
      .describe('Optional system prompt for all models in the chain'),
    max_tokens: z.number().int().min(1).max(128000).optional()
      .describe('Maximum tokens per response (default: 4096)'),
    max_steps: z.number().int().min(1).max(3).default(1)
      .describe('Hard cap on paid model calls. Defaults to 1; set 2 or 3 only after approving a cascade budget.'),
    confirm_paid_requests: z.literal(true)
      .describe('Must be true to confirm the potentially billable request budget.'),
    confirm_multiple_paid_requests: z.boolean().default(false)
      .describe('Must be true when max_steps is greater than 1.'),
  };

  server.tool(
    'cascade',
    'Budget-capped cascade. Defaults to one paid call; multi-step escalation requires explicit confirmation and reports aggregate token usage.',
    schema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      if (params.max_steps > 1 && !params.confirm_multiple_paid_requests) {
        return {
          content: [{ type: 'text' as const, text: 'Cascade refused: max_steps > 1 requires confirm_multiple_paid_requests=true.' }],
          isError: true,
        };
      }
      const augmentedPrompt = params.prompt + CONFIDENCE_SUFFIX;
      let catalogWarning: string | undefined;
      let catalogVersion: string | undefined;
      let chain = [...CASCADE_CHAIN];
      try {
        const catalog = await getTextCatalog();
        const available = new Set(catalog.data.models.filter(model => model.lifecycle !== 'retired').map(model => model.model_id));
        chain = chain.filter(model => available.has(model));
        catalogVersion = catalog.data.meta.catalog_version;
        catalogWarning = catalog.warning;
      } catch {
        catalogWarning = 'Canonical Catalog is unavailable; cascade is using its bundled policy chain.';
      }
      chain = chain.slice(0, params.max_steps);
      if (chain.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Cascade refused: no policy-chain model is currently available in canonical Catalog.' }], isError: true };
      }
      const attempts: string[] = [];
      const requestIds: string[] = [];
      let aggregateInputTokens = 0;
      let aggregateOutputTokens = 0;

      for (let i = 0; i < chain.length; i++) {
        const modelName = chain[i];
        const model = findModel(modelName);
        const isLast = i === chain.length - 1;

        try {
          const response = await chatRequest(config, {
            model: modelName,
            prompt: isLast ? params.prompt : augmentedPrompt,
            systemPrompt: params.system_prompt,
            maxTokens: params.max_tokens,
          });
          if (response.requestId) requestIds.push(response.requestId);
          if (response.usage) {
            aggregateInputTokens += response.usage.inputTokens;
            aggregateOutputTokens += response.usage.outputTokens;
          }

          if (isLast) {
            const reachedFlagship = modelName === CASCADE_CHAIN[CASCADE_CHAIN.length - 1];
            attempts.push(`${model?.description ?? modelName}: final (${reachedFlagship ? 'flagship' : 'budget cap'})`);
            const lines = [
              response.content,
              '',
              '---',
              `Cascade result: resolved at ${modelName} (Tier ${model?.tier ?? '?'})`,
              `Chain: ${attempts.join(' → ')}`,
            ];
            if (response.usage) {
              lines.push(`Tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
            }
            lines.push(`Aggregate tokens (${i + 1} paid step${i === 0 ? '' : 's'}): ${aggregateInputTokens} in / ${aggregateOutputTokens} out`);
            if (requestIds.length > 0) lines.push(`Request IDs: ${requestIds.join(', ')}`);
            if (catalogVersion) lines.push(`Catalog: ${catalogVersion}`);
            if (catalogWarning) lines.push(`Warning: ${catalogWarning}`);
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
          }

          const { content, confidence } = parseConfidence(response.content);

          if (confidence === 'high') {
            attempts.push(`${modelName}: ${confidence} ✓`);
            const lines = [
              content,
              '',
              '---',
              `Cascade result: resolved at ${modelName} (Tier ${model?.tier ?? '?'})`,
              `Confidence: ${confidence}`,
              `Chain: ${attempts.join(' → ')}`,
            ];
            if (response.usage) {
              lines.push(`Tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
            }
            lines.push(`Aggregate tokens (${i + 1} paid step${i === 0 ? '' : 's'}): ${aggregateInputTokens} in / ${aggregateOutputTokens} out`);
            if (requestIds.length > 0) lines.push(`Request IDs: ${requestIds.join(', ')}`);
            if (catalogVersion) lines.push(`Catalog: ${catalogVersion}`);
            if (catalogWarning) lines.push(`Warning: ${catalogWarning}`);
            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
          }

          attempts.push(`${modelName}: ${confidence} → escalate`);
        } catch (error) {
          if (error instanceof PaidRequestOutcomeUnknownError) throw error;
          attempts.push(`${modelName}: error → escalate`);
        }
      }

      // Should never reach here, but safety fallback
      return {
        content: [{
          type: 'text' as const,
          text: `Cascade failed at all levels. Attempted: ${attempts.join(' → ')}`,
        }],
      };
    },
  );
}
