import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RouterConfig } from '../config.js';
import { chatRequest } from '../services/api-client.js';
import { getModelNames, findModel } from '../data/text-models.js';

export function registerDelegate(server: McpServer, config: RouterConfig): void {
  const modelNames = getModelNames();

  const schema = {
    prompt: z.string().max(100000).describe('The prompt / message to send to the model'),
    model: z.enum(modelNames).describe('Target text model name'),
    system_prompt: z.string().max(10000).optional()
      .describe('Optional system prompt to set model behavior'),
    max_tokens: z.number().int().min(1).max(128000).optional()
      .describe('Maximum tokens in response (default: 4096)'),
    confirm_paid_request: z.literal(true)
      .describe('Must be true to confirm one potentially billable model request.'),
  };

  server.tool(
    'delegate',
    'Send a prompt to a specific text model and get the response. Use list_text_models to see available models.',
    schema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      const model = findModel(params.model);
      const response = await chatRequest(config, {
        model: params.model,
        prompt: params.prompt,
        systemPrompt: params.system_prompt,
        maxTokens: params.max_tokens,
      });

      const lines = [response.content];
      const meta: string[] = [];
      if (model) meta.push(`Model: ${model.name} (Tier ${model.tier}, ${model.provider})`);
      if (response.usage) {
        meta.push(`Tokens: ${response.usage.inputTokens} in / ${response.usage.outputTokens} out`);
      }
      if (response.requestId) meta.push(`Request ID: ${response.requestId}`);
      if (meta.length > 0) {
        lines.push('', '---', ...meta);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
