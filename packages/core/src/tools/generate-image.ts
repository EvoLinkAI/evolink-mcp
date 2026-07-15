import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { apiRequest, formatUsageInfo } from '../services/api-client.js';
import { findModel, getModelNames } from '../data/models.js';
import { CatalogModelUnavailableError, resolveCatalogModel } from '../services/catalog-client.js';

export function registerGenerateImage(server: McpServer, config: ServerConfig): void {
  const modelNames = getModelNames('image');

  const schema = {
    prompt: z.string().max(2000).describe('Image description prompt (max 2000 chars)'),
    model: z.string().default(modelNames[0])
      .describe('Canonical image model ID; validated against EvoLink Catalog at invocation time'),
    size: z.string().optional()
      .describe('Image size. WARNING: supported values vary by model. GPT models (gpt-image-1.5, gpt-image-1, gpt-4o-image): 1024x1024, 1024x1536, 1536x1024. Most other models use ratio format: 1:1, 16:9, 9:16, 2:3, 3:2, 4:3, 3:4, 4:5, 5:4, 21:9. If unsure, omit this parameter to use the model default.'),
    n: z.number().int().min(1).max(4).optional()
      .describe('Number of images to generate (1-4, model dependent)'),
    image_urls: z.array(z.string().url()).max(14).optional()
      .describe('Reference image URLs for image-to-image or editing'),
    mask_url: z.string().url().optional()
      .describe('Mask image URL (PNG) for partial editing (gpt-4o-image)'),
    confirm_cost: z.literal(true)
      .describe('Must be true to confirm submission of one potentially billable generation task.'),
  };

  server.tool(
    'generate_image',
    'Generate AI images. Returns task_id immediately. Use check_task to poll progress and get result.',
    schema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      const { confirm_cost: _confirmed, ...body } = params;
      let catalogVersion: string | undefined;
      let catalogWarning: string | undefined;
      try {
        const resolved = await resolveCatalogModel(params.model, 'image');
        body.model = resolved.model.model_id;
        catalogVersion = resolved.data.meta.catalog_version;
        catalogWarning = resolved.warning;
      } catch (error) {
        if (error instanceof CatalogModelUnavailableError || !findModel(params.model)) {
          return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Model validation failed' }], isError: true };
        }
        catalogWarning = `Canonical Catalog is unavailable; using bundled model metadata for ${params.model}.`;
      }
      const task = await apiRequest(config, {
        method: 'POST',
        path: '/v1/images/generations',
        body: body as Record<string, unknown>,
        tool: 'generate_image',
        catalogVersion,
      });

      const estimatedTime = task.task_info?.estimated_time ?? 30;
      const usageInfo = formatUsageInfo(task.usage);

      const lines = [
        `Image generation task submitted.`,
        `Task ID: ${task.id}`,
        `Status: pending`,
        `Estimated time: ~${estimatedTime}s`,
      ];
      if (task.request_id) lines.push(`Request ID: ${task.request_id}`);
      if (catalogVersion) lines.push(`Catalog: ${catalogVersion}`);
      if (catalogWarning) lines.push(`Warning: ${catalogWarning}`);
      if (usageInfo) lines.push(usageInfo);
      lines.push('', `Use check_task with task_id "${task.id}" to poll progress.`);
      lines.push(`Recommended polling interval: 3-5 seconds.`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
