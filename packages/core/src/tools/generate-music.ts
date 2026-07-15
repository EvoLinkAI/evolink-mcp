import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { apiRequest, formatUsageInfo } from '../services/api-client.js';
import { findModel, getModelNames } from '../data/models.js';
import { CatalogModelUnavailableError, resolveCatalogModel } from '../services/catalog-client.js';

export function registerGenerateMusic(server: McpServer, config: ServerConfig): void {
  const modelNames = getModelNames('music');

  const schema = {
    prompt: z.string().max(5000).describe(
      'In simple mode: music description (max 500 chars). In custom mode: lyrics with tags like [Verse], [Chorus] (max 3000 for v4, 5000 for v4.5+)',
    ),
    model: z.string().default(modelNames[0])
      .describe('Canonical audio model ID; validated against EvoLink Catalog at invocation time'),
    custom_mode: z.boolean()
      .describe('false = simple mode (AI generates lyrics/style from prompt). true = custom mode (you control style, title, lyrics)'),
    instrumental: z.boolean()
      .describe('true = instrumental only (no vocals). false = with vocals'),
    style: z.string().max(1000).optional()
      .describe('Music style tags, e.g. "pop, electronic, upbeat, female vocals, 120bpm". Required in custom mode'),
    title: z.string().max(80).optional()
      .describe('Song title (max 80 chars). Required in custom mode'),
    duration: z.number().int().min(30).max(240).optional()
      .describe('Target duration in seconds. suno-v4: 30-120s. suno-v4.5/v5: 30-240s. If omitted, model decides length.'),
    negative_tags: z.string().optional()
      .describe('Styles to exclude, e.g. "heavy metal, screaming"'),
    vocal_gender: z.enum(['m', 'f']).optional()
      .describe('Vocal gender preference: m = male, f = female. Only in custom mode'),
    confirm_cost: z.literal(true)
      .describe('Must be true to confirm submission of one potentially billable generation task.'),
  };

  server.tool(
    'generate_music',
    'Generate AI music with Suno models. Returns task_id immediately (1-2min). Use check_task to poll.',
    schema,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (params) => {
      const { confirm_cost: _confirmed, ...body } = params;
      let catalogVersion: string | undefined;
      let catalogWarning: string | undefined;
      try {
        const resolved = await resolveCatalogModel(params.model, 'audio');
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
        path: '/v1/audios/generations',
        body: body as Record<string, unknown>,
        tool: 'generate_music',
        catalogVersion,
      });

      const estimatedTime = task.task_info?.estimated_time ?? 90;
      const usageInfo = formatUsageInfo(task.usage);

      const lines = [
        `Music generation task submitted.`,
        `Task ID: ${task.id}`,
        `Status: pending`,
        `Estimated time: ~${estimatedTime}s`,
      ];
      if (task.request_id) lines.push(`Request ID: ${task.request_id}`);
      if (catalogVersion) lines.push(`Catalog: ${catalogVersion}`);
      if (catalogWarning) lines.push(`Warning: ${catalogWarning}`);
      if (usageInfo) lines.push(usageInfo);
      lines.push('', `Use check_task with task_id "${task.id}" to poll progress.`);
      lines.push(`Recommended polling interval: 5-10 seconds.`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
